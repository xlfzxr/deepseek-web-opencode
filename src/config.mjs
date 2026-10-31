// Runtime configuration: the single place that reads env, injected into every layer.
//
// Layers must not read `process.env` themselves (quality gate: runtime config is
// injected, not hardcoded). `readConfig()` is called once at bootstrap; tests can pass
// an explicit env object and get a pure config value back.

export const CHAT_MODEL = "deepseek-web/deepseek-chat";
export const REASONER_MODEL = "deepseek-web/deepseek-reasoner";
export const DEFAULT_MODELS = Object.freeze([CHAT_MODEL, REASONER_MODEL]);

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_API_KEY_HINT = "deepseek";
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
export const DEFAULT_CORS_MAX_AGE_SECONDS = 600;

const RISK_DEFAULTS = Object.freeze({
  ttlMs: 10 * 60 * 1000,
  retryMs: 60 * 1000,
  timeoutMs: 4000,
});

function numberOrUndefined(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveNumber(value, fallback) {
  const parsed = numberOrUndefined(value);
  return parsed !== undefined && parsed > 0 ? parsed : fallback;
}

export function flagEnabled(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  return !/^(0|false|off|no)$/i.test(String(value).trim());
}

export function readConfig(env = process.env) {
  return {
    port: Math.trunc(positiveNumber(env.PORT, DEFAULT_PORT)),
    host: String(env.DEEPSEEK_BRIDGE_HOST || DEFAULT_HOST).trim() || DEFAULT_HOST,
    cors: {
      allowOrigins: env.DEEPSEEK_BRIDGE_ALLOW_ORIGINS || "",
      maxAgeSeconds: Math.trunc(
        positiveNumber(env.DEEPSEEK_BRIDGE_CORS_MAX_AGE, DEFAULT_CORS_MAX_AGE_SECONDS),
      ),
    },
    sse: {
      heartbeatMs: Math.trunc(
        positiveNumber(env.DEEPSEEK_SSE_HEARTBEAT_MS, DEFAULT_SSE_HEARTBEAT_MS),
      ),
    },
    models: DEFAULT_MODELS,
    apiKeyHint: DEFAULT_API_KEY_HINT,
    // Options handed to the header layer (see src/headers/upstream.mjs).
    header: {
      env: {},
      authDir: env.DEEPSEEK_AUTH_DIR || undefined,
      capturePath: env.DEEPSEEK_FINGERPRINT_PATH || undefined,
      devicePath: env.DEEPSEEK_DEVICE_PATH || undefined,
      deviceId: env.DEEPSEEK_DEVICE_ID || undefined,
      inlineCapture: env.DEEPSEEK_FINGERPRINT_JSON || undefined,
      userAgent: env.DEEPSEEK_FINGERPRINT_UA || undefined,
      locale: env.DEEPSEEK_LOCALE || undefined,
      acceptLanguage: env.DEEPSEEK_ACCEPT_LANGUAGE || undefined,
      timezoneOffsetSeconds: numberOrUndefined(env.DEEPSEEK_TZ_OFFSET),
      clientVersion: env.DEEPSEEK_CLIENT_VERSION || undefined,
      bundleId: env.DEEPSEEK_CLIENT_BUNDLE_ID || undefined,
      origin: env.DEEPSEEK_ORIGIN || undefined,
      riskHeaders: flagEnabled(env.DEEPSEEK_RISK_HEADERS, true),
      riskTtlMs: numberOrUndefined(env.DEEPSEEK_RISK_TTL_MS) ?? RISK_DEFAULTS.ttlMs,
      riskRetryMs: numberOrUndefined(env.DEEPSEEK_RISK_RETRY_MS) ?? RISK_DEFAULTS.retryMs,
      riskTimeoutMs: numberOrUndefined(env.DEEPSEEK_RISK_TIMEOUT_MS) ?? RISK_DEFAULTS.timeoutMs,
    },
    auth: {
      path: env.DEEPSEEK_AUTH_PATH || undefined,
      cdpPort: Math.trunc(positiveNumber(env.DEEPSEEK_CDP_PORT, 9222)),
    },
  };
}
