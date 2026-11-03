// DeepSeek risk-header cache (x-hif-*): 10-minute tokens, single-flight, soft failure.
//
// The 2026 web client attaches short-lived risk tokens that DeepSeek's WAF expects on
// /api/v0 calls. They are pulled from dedicated hosts and expire after ~10 minutes:
//   GET https://hif-leim.deepseek.com/query -> { data: { biz_data: { value } } }
//   GET https://hif-dliq.deepseek.com/query -> { data: { biz_data: { value } } }
// A failure here must never block chat: the bridge simply proceeds without them.

export const DEFAULT_RISK_HEADERS = {
  "x-hif-leim": "hif-leim.deepseek.com",
  "x-hif-dliq": "hif-dliq.deepseek.com",
};

const MAX_VALUE_LENGTH = 4096;

function singleLine(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text || text.length > MAX_VALUE_LENGTH || /[\r\n]/.test(text)) return "";
  return text;
}

function extractValue(payload) {
  if (!payload || typeof payload !== "object") return "";
  const candidates = [
    payload?.data?.biz_data?.value,
    payload?.data?.value,
    payload?.biz_data?.value,
    payload?.value,
  ];
  for (const candidate of candidates) {
    const text = singleLine(candidate);
    if (text) return text;
  }
  return "";
}

export function createRiskHeaderCache(options = {}) {
  const enabled = options.enabled !== false;
  const hosts = { ...DEFAULT_RISK_HEADERS, ...(options.hosts || {}) };
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : 10 * 60 * 1000;
  const retryMs = Number(options.retryMs) > 0 ? Number(options.retryMs) : 60 * 1000;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 4000;
  const fetcher = options.fetcher || ((...args) => globalThis.fetch(...args));
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const log = typeof options.log === "function" ? options.log : () => {};

  const baseHeaders = {
    accept: "application/json, text/plain, */*",
    "accept-language": options.acceptLanguage || "en-US,en;q=0.9",
    "user-agent": options.userAgent || "",
  };

  let cached = {};
  let expiresAt = 0;
  let blockedUntil = 0;
  let inflight = null;
  let lastError = "";

  function snapshot() {
    return {
      enabled,
      cached: Object.keys(cached).length,
      names: Object.keys(cached),
      expiresAt: expiresAt || null,
      expiresInMs: expiresAt ? Math.max(0, expiresAt - now()) : 0,
      blockedForMs: blockedUntil > now() ? blockedUntil - now() : 0,
      lastError,
    };
  }

  function timeoutSignal() {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      return AbortSignal.timeout(timeoutMs);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    return controller.signal;
  }

  async function fetchOne(host) {
    const response = await fetcher(`https://${host}/query`, {
      headers: baseHeaders,
      signal: timeoutSignal(),
    });
    if (!response || !response.ok) {
      throw new Error(`HTTP ${response?.status ?? "?"}`);
    }
    return extractValue(await response.json());
  }

  async function refresh() {
    const values = await Promise.allSettled(
      Object.entries(hosts).map(async ([header, host]) => [header, await fetchOne(host)]),
    );

    const next = {};
    for (const result of values) {
      if (result.status !== "fulfilled") continue;
      const [header, value] = result.value;
      if (value) next[header] = value;
    }

    if (Object.keys(next).length === 0) {
      blockedUntil = now() + retryMs;
      lastError = "risk headers unavailable";
      log("风控头获取失败，继续不带 x-hif-* 请求。", "warn");
      return cached;
    }

    cached = next;
    expiresAt = now() + ttlMs;
    blockedUntil = 0;
    lastError = "";
    log(`已获取风控头：${Object.keys(cached).join(", ")}`);
    return cached;
  }

  async function get() {
    if (!enabled) return {};
    if (Object.keys(cached).length > 0 && now() < expiresAt) return cached;
    if (now() < blockedUntil) return cached;
    if (inflight) return inflight;

    inflight = refresh()
      .catch((error) => {
        // fetchOne already soft-fails; this is belt-and-braces for unexpected throws.
        blockedUntil = now() + retryMs;
        lastError = error?.message || String(error);
        return cached;
      })
      .finally(() => {
        inflight = null;
      });

    return inflight;
  }

  function invalidate() {
    cached = {};
    expiresAt = 0;
    blockedUntil = 0;
    lastError = "";
  }

  return { get, refresh, invalidate, snapshot };
}
