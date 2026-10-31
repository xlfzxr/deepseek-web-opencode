// SSE writer: frame helpers plus a hardened stream opener (flush, no-buffer, heartbeat).
//
// Why this exists: SSE breaks in boring ways. A proxy buffers the response, a runtime
// holds the first chunk, a dead client keeps the upstream request alive, or a mobile
// network idle-times out a long reasoning stream. openSse() handles all three:
//   - headers that disable buffering (`no-transform`, `x-accel-buffering: no`)
//   - an immediate flush so opencode/EventSource see the stream open
//   - a comment heartbeat so idle connections stay alive
//   - an AbortSignal tied to the client connection so upstream fetch is cancelled

import { createRequestAbort } from "./http.mjs";

export const SSE_BASE_HEADERS = Object.freeze({
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-store, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
});

const DEFAULT_HEARTBEAT_MS = 15_000;

function writable(res) {
  return Boolean(res) && !res.writableEnded && !res.destroyed;
}

function safeWrite(res, chunk) {
  if (!writable(res)) return false;
  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

export function sseWrite(res, payload) {
  return safeWrite(res, `data: ${JSON.stringify(payload)}\n\n`);
}

export function sseEvent(res, event, payload) {
  return safeWrite(res, `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function sseComment(res, text = "") {
  return safeWrite(res, `: ${text}\n\n`);
}

export function sseDone(res) {
  return safeWrite(res, "data: [DONE]\n\n");
}

export function openSse(res, options = {}) {
  // Config layer injects heartbeatMs; the default keeps direct use sane.
  const heartbeatMs =
    Number(options.heartbeatMs) > 0 ? Number(options.heartbeatMs) : DEFAULT_HEARTBEAT_MS;
  const retryMs = Number(options.retryMs) > 0 ? Number(options.retryMs) : 0;
  const initialComment =
    options.initialComment === undefined ? "connected" : options.initialComment;

  res.writeHead(options.status || 200, {
    ...SSE_BASE_HEADERS,
    ...(options.headers || {}),
  });

  // Push headers + first frame out now; some runtimes only flush on first write.
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  res.socket?.setNoDelay?.(true);

  const abort = options.signal ? null : createRequestAbort(res);
  const signal = options.signal || abort.signal;
  const closeHandlers = [];
  let heartbeat = null;
  let closed = false;

  function stopHeartbeat() {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function finishHandlers() {
    for (const handler of closeHandlers.splice(0)) {
      try {
        handler();
      } catch {
        // A broken close handler must not crash the request.
      }
    }
  }

  res.on("close", () => {
    closed = true;
    stopHeartbeat();
    finishHandlers();
  });
  res.on("finish", stopHeartbeat);

  function writeRaw(chunk) {
    return safeWrite(res, chunk);
  }
  function data(payload) {
    return safeWrite(res, `data: ${JSON.stringify(payload)}\n\n`);
  }
  function event(name, payload) {
    return safeWrite(res, `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
  }
  function comment(text = "") {
    return safeWrite(res, `: ${text}\n\n`);
  }
  function done() {
    return safeWrite(res, "data: [DONE]\n\n");
  }
  function end() {
    stopHeartbeat();
    if (!writable(res)) {
      abort?.dispose?.();
      return false;
    }
    try {
      res.end();
      return true;
    } catch {
      return false;
    } finally {
      abort?.dispose?.();
    }
  }
  function onClose(handler) {
    if (typeof handler === "function") closeHandlers.push(handler);
  }

  // EventSource reconnects with whatever delay the server suggests.
  if (retryMs > 0) writeRaw(`retry: ${retryMs}\n\n`);
  if (initialComment) comment(initialComment);

  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      // Skip the ping if the socket is already backed up.
      if (!writable(res) || res.writableLength > 1_000_000) return;
      comment("keep-alive");
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  return {
    res,
    signal,
    data,
    event,
    comment,
    done,
    end,
    writeRaw,
    onClose,
    get closed() {
      return closed;
    },
    dispose() {
      stopHeartbeat();
      abort?.dispose?.();
      finishHandlers();
    },
  };
}
