// Error handler: convert application failures into the stable JSON/SSE error shapes.
import { ErrorCode } from "@deepseek-web-opencode/core/orchestration/errors";
import { sendJson } from "@deepseek-web-opencode/transport/http";
import { sseDone, sseWrite } from "@deepseek-web-opencode/transport/sse-writer";

export function createErrorHandler({ state, pushLog }) {
  return function handleError(error, res) {
    const message = error?.message || String(error);
    const aborted = error?.name === "AbortError" || error?.code === ErrorCode.CANCELLED;

    if (aborted) {
      if (!res.destroyed && !res.writableEnded) {
        pushLog("客户端已断开，上游请求已取消。");
      }
      return;
    }

    state.lastError = message;
    pushLog(message, "error");
    if (res.destroyed || res.writableEnded) return;

    const code = error?.code ? { code: error.code } : {};
    const retryable =
      error?.retryable !== undefined ? { retryable: Boolean(error.retryable) } : {};

    if (!res.headersSent) {
      // JSON error contract: string `error` (stable) plus optional code metadata.
      sendJson(res, 500, { error: message, ...code, ...retryable });
      return;
    }

    // SSE error contract: keep the historical { error: { message } } shape.
    sseWrite(res, { error: { message, ...code, ...retryable } });
    sseDone(res);
    res.end();
  };
}
