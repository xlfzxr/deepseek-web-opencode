// Header layer: orchestrates fingerprint + same-origin + credentials + PoW/risk headers.
//
// Call sites only say *which endpoint* they are calling; this module owns the ordering,
// the invariants (same-origin, coherent client hints) and the dynamic pieces:
//   - a persisted x-device-id (stable across restarts)
//   - fresh x-hif-* risk tokens (10 min cache, soft failure)
//   - an optional exact fingerprint captured from the real browser
//
// Everything here is synchronous except refreshRiskHeaders().

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  DEEPSEEK_ORIGIN,
  buildFingerprint,
  redactHeaders,
  sanitizeCapturedHeaders,
  validateFingerprint,
} from "./fingerprint.mjs";
import { createRiskHeaderCache } from "./risk.mjs";

export const ENDPOINTS = Object.freeze({
  settings: "/api/v0/client/settings",
  powChallenge: "/api/v0/chat/create_pow_challenge",
  createSession: "/api/v0/chat_session/create",
  completion: "/api/v0/chat/completion",
});

const DEFAULT_CLIENT_VERSION = "2.7.0";
const DEFAULT_BUNDLE_ID = "com.deepseek.chat";

function defaultAuthDir(env = {}) {
  return env.DEEPSEEK_AUTH_DIR || path.resolve(process.cwd(), ".deepseek-auth");
}

function readJson(readFile, filePath) {
  try {
    const raw = readFile(filePath);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function numberOrUndefined(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function flagEnabled(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  return !/^(0|false|off|no)$/i.test(String(value).trim());
}

function pickCaptureHeaders(raw) {
  if (!raw || typeof raw !== "object") return {};
  if (raw.headers && typeof raw.headers === "object") return raw.headers;
  if (raw.fingerprint && typeof raw.fingerprint === "object") return raw.fingerprint;
  // Raw CDP capture from `.capture-ds2.mjs`: prefer the completion request.
  const hits = Array.isArray(raw.hits) ? raw.hits : [];
  const completion = hits.find((hit) => String(hit?.url || "").includes("/chat/completion"));
  const candidate = completion || hits[0];
  if (candidate?.headers && typeof candidate.headers === "object") {
    return { ...(candidate.extra || {}), ...candidate.headers };
  }
  const all = Array.isArray(raw.all) ? raw.all : [];
  const anyCompletion = all.find((entry) => String(entry?.url || "").includes("/chat/completion"));
  if (anyCompletion?.headers) return anyCompletion.headers;
  return raw;
}

export function loadCaptureFile(filePath, readFile = (p) => fs.readFileSync(p, "utf8")) {
  const raw = readJson(readFile, filePath);
  if (!raw) return null;
  const { headers, dropped } = sanitizeCapturedHeaders(pickCaptureHeaders(raw));
  if (Object.keys(headers).length === 0) return null;
  return {
    headers,
    dropped,
    capturedAt: raw.capturedAt || raw.captured_at || null,
    source: String(raw.source || filePath),
    filePath,
  };
}

function resolveDeviceId({ deviceId, devicePath, env, readFile, writeFile, log }) {
  const explicit = String(deviceId || env.DEEPSEEK_DEVICE_ID || "").trim();
  if (explicit) return { deviceId: explicit, source: "env" };

  const existing = readJson(readFile, devicePath);
  if (typeof existing?.deviceId === "string" && existing.deviceId.trim()) {
    return { deviceId: existing.deviceId.trim(), source: "file" };
  }

  const generated = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(devicePath), { recursive: true });
    writeFile(devicePath, `${JSON.stringify({ deviceId: generated, createdAt: new Date().toISOString() }, null, 2)}\n`);
    log?.(`已生成设备指纹 x-device-id：${generated}`);
  } catch {
    // Read-only filesystem: keep the id for this process only.
  }
  return { deviceId: generated, source: "generated" };
}

function cleanExtraHeaders(extra = {}) {
  const headers = {};
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null) continue;
    const name = String(key).trim().toLowerCase();
    const text = String(value);
    if (!name || /[\r\n]/.test(text)) continue;
    headers[name] = text;
  }
  return headers;
}

export function createHeaderLayer(options = {}) {
  const env = options.env || process.env;
  const log = options.log || (() => {});
  const readFile = options.readFile || ((filePath) => fs.readFileSync(filePath, "utf8"));
  const writeFile = options.writeFile || ((filePath, data) => fs.writeFileSync(filePath, data));

  const cookie = String(options.cookie ?? "").trim();
  const bearer = String(options.bearer ?? "").trim();

  const authDir = options.authDir || defaultAuthDir(env);
  const capturePath =
    options.capturePath || env.DEEPSEEK_FINGERPRINT_PATH || path.join(authDir, "fingerprint.json");
  const devicePath =
    options.devicePath || env.DEEPSEEK_DEVICE_PATH || path.join(authDir, "device.json");

  let captured = null;
  const inlineCapture = String(options.inlineCapture || env.DEEPSEEK_FINGERPRINT_JSON || "").trim();
  if (inlineCapture) {
    try {
      captured = { headers: sanitizeCapturedHeaders(JSON.parse(inlineCapture)).headers, source: "env" };
    } catch {
      log("DEEPSEEK_FINGERPRINT_JSON 不是合法 JSON，已忽略。", "warn");
    }
  }
  if (!captured) captured = loadCaptureFile(capturePath, readFile);

  const device = resolveDeviceId({
    deviceId: options.deviceId,
    devicePath,
    env,
    readFile,
    writeFile,
    log,
  });

  const fingerprint = buildFingerprint({
    userAgent: options.userAgent || env.DEEPSEEK_FINGERPRINT_UA,
    locale: options.locale || env.DEEPSEEK_LOCALE,
    acceptLanguage: options.acceptLanguage || env.DEEPSEEK_ACCEPT_LANGUAGE,
    timezoneOffsetSeconds:
      numberOrUndefined(options.timezoneOffsetSeconds) ??
      numberOrUndefined(env.DEEPSEEK_TZ_OFFSET),
    clientVersion:
      options.clientVersion || env.DEEPSEEK_CLIENT_VERSION || DEFAULT_CLIENT_VERSION,
    bundleId: options.bundleId || env.DEEPSEEK_CLIENT_BUNDLE_ID || DEFAULT_BUNDLE_ID,
    origin: options.origin || env.DEEPSEEK_ORIGIN || DEEPSEEK_ORIGIN,
    deviceId: device.deviceId,
    capturedHeaders: captured?.headers,
    capturedAt: captured?.capturedAt,
    capturedSource: captured?.source,
  });

  if (captured?.dropped?.length) {
    fingerprint.captureDropped = captured.dropped;
  }

  const risk = createRiskHeaderCache({
    enabled: flagEnabled(options.riskHeaders ?? env.DEEPSEEK_RISK_HEADERS, true),
    ttlMs: numberOrUndefined(options.riskTtlMs ?? env.DEEPSEEK_RISK_TTL_MS),
    retryMs: numberOrUndefined(options.riskRetryMs ?? env.DEEPSEEK_RISK_RETRY_MS),
    timeoutMs: numberOrUndefined(options.riskTimeoutMs ?? env.DEEPSEEK_RISK_TIMEOUT_MS),
    userAgent: fingerprint.userAgent,
    acceptLanguage: fingerprint.acceptLanguage,
    fetcher: options.fetcher,
    log,
  });

  const base = fingerprint.headers;
  const capturedKeys = new Set(Object.keys(captured?.headers || {}));
  const leadKeys = ["accept", "accept-encoding", "accept-language"];

  // Compose one request: the only place where upstream headers are assembled.
  function compose(extra = {}) {
    const method = String(extra.method || "POST").toUpperCase();
    const wantsJson = extra.json ?? method !== "GET";
    const headers = {};
    const sources = {};

    for (const key of leadKeys) {
      if (base[key] !== undefined) {
        headers[key] = base[key];
        sources[key] = capturedKeys.has(key) ? "capture" : "fingerprint";
      }
    }
    if (bearer) {
      headers.authorization = `Bearer ${bearer}`;
      sources.authorization = "credentials";
    }
    if (wantsJson && method !== "GET") {
      headers["content-type"] = "application/json";
      sources["content-type"] = "endpoint";
    }
    if (cookie) {
      headers.cookie = cookie;
      sources.cookie = "credentials";
    }

    for (const [key, value] of Object.entries(base)) {
      if (key in headers) continue;
      headers[key] = value;
      sources[key] = capturedKeys.has(key) ? "capture" : "fingerprint";
    }

    if (extra.powResponse) {
      headers["x-ds-pow-response"] = String(extra.powResponse);
      sources["x-ds-pow-response"] = "pow";
    }
    for (const [key, value] of Object.entries(cleanExtraHeaders(extra.riskHeaders))) {
      headers[key] = value;
      sources[key] = "risk";
    }
    for (const [key, value] of Object.entries(cleanExtraHeaders(extra.extra))) {
      headers[key] = value;
      sources[key] = "extra";
    }

    return { headers, sources };
  }

  function forEndpoint(endpoint = ENDPOINTS.completion, extra = {}) {
    return compose(extra).headers;
  }

  function explain(endpoint = ENDPOINTS.completion, extra = {}) {
    const { headers, sources } = compose(extra);
    return { endpoint, headers: redactHeaders(headers), sources };
  }

  async function refreshRiskHeaders() {
    return risk.get();
  }

  function describe(endpoint = ENDPOINTS.completion) {
    const composed = compose({
      powResponse: "pow-placeholder",
      riskHeaders: risk.snapshot().names.reduce((acc, name) => {
        acc[name] = "risk-placeholder";
        return acc;
      }, {}),
    });
    const sample = composed.headers;
    const sources = composed.sources;

    return {
      origin: fingerprint.origin,
      referer: fingerprint.referer,
      userAgent: fingerprint.userAgent,
      browser: fingerprint.browser,
      browserMajor: fingerprint.browserMajor,
      platform: fingerprint.platform,
      mobile: fingerprint.mobile,
      locale: fingerprint.locale,
      requestLocale: fingerprint.requestLocale,
      acceptLanguage: fingerprint.acceptLanguage,
      timezoneOffsetSeconds: fingerprint.timezoneOffsetSeconds,
      clientVersion: fingerprint.clientVersion,
      bundleId: fingerprint.bundleId,
      deviceId: (sample["x-device-id"] || "").slice(0, 8),
      deviceSource: captured?.headers?.["x-device-id"] ? "capture" : device.source,
      source: fingerprint.source,
      capturePath: captured?.filePath || null,
      capturedAt: fingerprint.capturedAt || null,
      capturedHeaderCount: fingerprint.capturedHeaderCount || 0,
      captureDropped: fingerprint.captureDropped || [],
      risk: risk.snapshot(),
      warnings: fingerprint.warnings,
      headers: redactHeaders(sample),
      sources,
    };
  }

  return {
    fingerprint,
    risk,
    forEndpoint,
    explain,
    refreshRiskHeaders,
    describe,
    get capturePath() {
      return captured?.filePath || capturePath;
    },
  };
}

export { validateFingerprint, redactHeaders, sanitizeCapturedHeaders };
