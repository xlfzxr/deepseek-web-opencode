// Provider adapter failure metadata. Leaf module: no project imports, no transport types.
//
// The adapter must not import orchestration, so it reports *what went wrong upstream*
// (kind/status/retryable) and `src/orchestration/pipeline.mjs` maps that to a stable
// gateway `ErrorCode`. Never let a raw fetch/HTML error reach the transport layer.

export const UpstreamErrorKind = Object.freeze({
  AUTH: "auth",
  RATE_LIMIT: "rate_limit",
  WAF: "waf",
  TIMEOUT: "timeout",
  UPSTREAM: "upstream",
  PROTOCOL: "protocol",
});

const RETRYABLE_KINDS = new Set([
  UpstreamErrorKind.RATE_LIMIT,
  UpstreamErrorKind.TIMEOUT,
  UpstreamErrorKind.UPSTREAM,
]);

export function looksLikeHtml(body) {
  const text = String(body || "").trim();
  return text.startsWith("<") || /<html|<!doctype/i.test(text);
}

export function classifyUpstreamFailure(status, body = "") {
  const text = String(body || "");
  const html = looksLikeHtml(text);
  const numeric = Number(status);

  if (numeric === 408 || numeric === 504) return { kind: UpstreamErrorKind.TIMEOUT, retryable: true };
  if (numeric === 429) return { kind: UpstreamErrorKind.RATE_LIMIT, retryable: true };
  if (numeric === 401) return { kind: UpstreamErrorKind.AUTH, retryable: false };
  if (numeric === 403) {
    if (html || /waf|blocked|cloudflare|challenge|验证码|风控/i.test(text)) {
      return { kind: UpstreamErrorKind.WAF, retryable: false };
    }
    return { kind: UpstreamErrorKind.AUTH, retryable: false };
  }
  if (/captcha|hcaptcha|verification|验证码|风控/i.test(text)) {
    return { kind: UpstreamErrorKind.WAF, retryable: false };
  }
  if (numeric >= 500) return { kind: UpstreamErrorKind.UPSTREAM, retryable: true };
  return { kind: UpstreamErrorKind.UPSTREAM, retryable: false };
}

export class UpstreamError extends Error {
  constructor(message, options = {}) {
    super(String(message), options.cause ? { cause: options.cause } : undefined);
    this.name = "UpstreamError";
    this.status = Number(options.status) || 0;
    this.kind = options.kind || UpstreamErrorKind.UPSTREAM;
    this.retryable =
      options.retryable === undefined ? RETRYABLE_KINDS.has(this.kind) : Boolean(options.retryable);
    this.detail = String(options.detail || "").replace(/\s+/g, " ").trim().slice(0, 300);
    this.hint = String(options.hint || "");
  }

  // Stable, log-safe shape (never includes cookie/authorization).
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      kind: this.kind,
      retryable: this.retryable,
      detail: this.detail,
    };
  }
}

export function isUpstreamError(error) {
  return error instanceof UpstreamError || error?.name === "UpstreamError";
}

export function upstreamHttpError(label, response, body) {
  const { kind, retryable } = classifyUpstreamFailure(response?.status, body);
  const detail = String(body || "");
  const hint =
    kind === UpstreamErrorKind.WAF
      ? "上游返回拦截页；检查 /api/fingerprint 的 warnings，或导入浏览器抓包（npm run fingerprint:capture）"
      : "";
  return new UpstreamError(`${label}：HTTP ${response?.status ?? "?"}`, {
    status: response?.status,
    kind,
    retryable,
    detail,
    hint,
  });
}
