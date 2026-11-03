// Local CORS/same-origin policy for the bridge (browser callers, preflight, SSE).
//
// The bridge itself listens on loopback and most clients (opencode TUI, curl, Codex)
// never send an Origin header. Browser-based callers do, and an SSE request with a
// rejected origin fails as an opaque CORS error, which is hard to debug. So:
//   - non-browser callers (no Origin) are always allowed
//   - loopback origins are allowed by default, any port
//   - DEEPSEEK_BRIDGE_ALLOW_ORIGINS adds origins ("*" allows everything)
//   - a rejected origin gets an explicit JSON 403 instead of a silent block

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|\[::ffff:127\.0\.0\.1\])(:\d{1,5})?$/i;

const DEFAULT_ALLOW_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "accept-language",
  "x-api-key",
  "x-requested-with",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-arch",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-timeout",
  "openai-organization",
  "openai-project",
  "openai-beta",
];

export const EXPOSED_HEADERS = [
  "content-type",
  "x-request-id",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
];

function normalizeOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.toLowerCase() === "null") return "null";
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

export function createCorsPolicy(rawValue, options = {}) {
  const entries = String(rawValue || "")
    .split(",")
    .map((entry) => normalizeOrigin(entry))
    .filter(Boolean);

  const allowAll = entries.includes("*");
  const origins = new Set(entries.filter((entry) => entry !== "*"));
  const allowLoopback = options.allowLoopback !== false;

  return {
    allowAll,
    origins,
    allowLoopback,
    allowNull: origins.has("null"),
    maxAgeSeconds: Number(options.maxAgeSeconds) > 0 ? Number(options.maxAgeSeconds) : 600,
    configured: entries.length > 0,
  };
}

export function isOriginAllowed(origin, policy = createCorsPolicy("")) {
  if (!origin) return true; // non-browser client
  if (policy.allowAll) return true;
  if (origin === "null") return Boolean(policy.allowNull);
  if (policy.origins.has(origin)) return true;
  if (policy.allowLoopback && LOOPBACK_ORIGIN.test(origin)) return true;
  return false;
}

function requestedHeadersList(req) {
  const raw = String(req.headers["access-control-request-headers"] || "");
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

// Decide what to do for this request. Pure-ish: reads request headers only.
export function evaluateCors(req, policy) {
  const origin = normalizeOrigin(req.headers.origin);
  const preflight = req.method === "OPTIONS" && Boolean(req.headers["access-control-request-method"]);
  const requestedHeaders = requestedHeadersList(req);
  const privateNetwork = Boolean(req.headers["access-control-request-private-network"]);
  return {
    origin,
    allowed: isOriginAllowed(origin, policy),
    preflight,
    requestedHeaders,
    allowHeaders: requestedHeaders.length > 0 ? requestedHeaders : DEFAULT_ALLOW_HEADERS,
    privateNetwork,
  };
}

export function applyCorsHeaders(res, decision) {
  if (!decision.origin || !decision.allowed) return;
  res.setHeader("access-control-allow-origin", decision.origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-expose-headers", EXPOSED_HEADERS.join(", "));
}

export function applyPreflightHeaders(res, decision, maxAgeSeconds = 600) {
  if (!decision.allowed) return;
  applyCorsHeaders(res, decision);
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", decision.allowHeaders.join(", "));
  res.setHeader("access-control-max-age", String(maxAgeSeconds));
  if (decision.privateNetwork) {
    res.setHeader("access-control-allow-private-network", "true");
  }
}

export function writePreflightResponse(res, decision, maxAgeSeconds = 600) {
  applyPreflightHeaders(res, decision, maxAgeSeconds);
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}
