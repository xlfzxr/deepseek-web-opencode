// Pipeline: menjalankan satu chat completion DeepSeek Web dan melemparkan event internal.
import { parseDeepSeekStream } from "../deepseek-web-client.mjs";
import { isUpstreamError } from "../upstream-error.mjs";
import { evMeta, evText, evReasoning, evDone } from "./events.mjs";
import { BridgeError, ErrorCode } from "./errors.mjs";

const KIND_TO_CODE = Object.freeze({
  auth: ErrorCode.AUTH_EXPIRED,
  rate_limit: ErrorCode.RATE_LIMITED,
  waf: ErrorCode.WAF_BLOCKED,
  timeout: ErrorCode.UPSTREAM_TIMEOUT,
  upstream: ErrorCode.UPSTREAM_ERROR,
  protocol: ErrorCode.UPSTREAM_STREAM_BROKEN,
});

// Stable adapter failure -> gateway error. Every upstream/stream error passes through here
// so the transport layer only ever sees BridgeError with a stable code.
export function mapUpstreamFailure(error, { phase = "upstream", signal } = {}) {
  if (error instanceof BridgeError) return error;

  if (error?.name === "AbortError") {
    return new BridgeError(ErrorCode.CANCELLED, "上游请求已取消。", {
      phase,
      cause: error,
    });
  }
  if (error?.name === "TimeoutError") {
    return new BridgeError(ErrorCode.UPSTREAM_TIMEOUT, "上游响应超时。", {
      phase,
      retryable: true,
      cause: error,
    });
  }

  if (isUpstreamError(error)) {
    let code = KIND_TO_CODE[error.kind] || ErrorCode.UPSTREAM_ERROR;
    if (phase === "session" && code === ErrorCode.UPSTREAM_ERROR) {
      code = ErrorCode.SESSION_CREATE_FAILED;
    }
    return new BridgeError(code, error.message, {
      phase,
      retryable: Boolean(error.retryable),
      cause: error,
    });
  }

  // A generic throw mid-stream is a broken stream, not a fresh upstream failure.
  const code = phase === "stream" ? ErrorCode.UPSTREAM_STREAM_BROKEN : ErrorCode.UPSTREAM_ERROR;
  return new BridgeError(code, error?.message || String(error), {
    phase,
    retryable: phase === "stream",
    cause: error,
  });
}

export function createPipeline({
  authManager,
  sessionStore,
  log = () => {},
  defaultModel = "deepseek-web/deepseek-chat",
}) {
  async function ensureSession(client, sessionKey, signal) {
    const cached = sessionStore.get(sessionKey);
    if (cached?.sessionId) return cached;
    const session = await client.createChatSession(signal);
    const next = { sessionId: session.chat_session_id, parentMessageId: null };
    sessionStore.set(sessionKey, next);
    return next;
  }

  return {
    async *runChatCompletion(normalized, ctx, signal) {
      const sessionKey = normalized.sessionKey || "default";
      const model = normalized.model || defaultModel;
      const prompt = normalized.prompt || "";

      if (!prompt.trim()) {
        throw new BridgeError(ErrorCode.INVALID_REQUEST, "没有可发送给 DeepSeek 的消息。");
      }

      let client;
      try {
        client = await authManager.getClient(signal);
      } catch (error) {
        throw mapUpstreamFailure(error, { phase: "auth", signal });
      }

      let session;
      try {
        session = await ensureSession(client, sessionKey, signal);
      } catch (error) {
        throw mapUpstreamFailure(error, { phase: "session", signal });
      }

      log(`发送到 DeepSeek Web：${prompt.slice(0, 60).replace(/\s+/g, " ")}`);

      let deepSeekStream;
      try {
        deepSeekStream = await client.chatCompletions({
          sessionId: session.sessionId,
          parentMessageId: session.parentMessageId,
          message: prompt,
          model,
          searchEnabled: Boolean(normalized.searchEnabled),
          signal,
        });
      } catch (error) {
        throw mapUpstreamFailure(error, { phase: "upstream", signal });
      }

      let fullText = "";
      try {
        for await (const event of parseDeepSeekStream(deepSeekStream)) {
          if (event.type === "meta" && event.parentMessageId) {
            session.parentMessageId = event.parentMessageId;
            sessionStore.set(sessionKey, session);
            yield evMeta(ctx, event.parentMessageId);
            continue;
          }

          if (event.type !== "text" && event.type !== "reasoning") continue;
          const delta = event.delta || "";
          if (!delta) continue;
          if (event.type === "text") {
            fullText += delta;
            yield evText(ctx, delta);
          } else {
            yield evReasoning(ctx, delta);
          }
        }
      } catch (error) {
        throw mapUpstreamFailure(error, { phase: "stream", signal });
      }

      log(`DeepSeek Web 回复完成：${fullText.length} 字符。`);
      yield evDone(ctx, { content: fullText });
    },
  };
}
