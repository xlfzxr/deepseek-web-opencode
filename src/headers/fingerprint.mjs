// Coherent browser fingerprint for upstream calls: every derived header agrees with the login UA.
//
// The bridge is a non-browser client pretending to be chat.deepseek.com's own web app.
// WAFs do not look at one header, they look at *contradictions* between headers:
//   - UA says Chrome/131 but sec-ch-ua says 120        -> bot
//   - sec-ch-ua-platform "Windows" with "?1" mobile    -> bot
//   - Origin/Referer that is not chat.deepseek.com     -> cross-site call
//   - sec-fetch-site "none"/"cross-site" on an XHR     -> not the web app
//
// This module is pure (no imports, no I/O) so it can be unit-tested and reused by
// the capture importer. `src/headers/upstream.mjs` is the orchestration around it.

export const DEEPSEEK_ORIGIN = "https://chat.deepseek.com";
export const DEEPSEEK_HOST = "chat.deepseek.com";
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Client hints only exist from Chrome 89 and are not sent by Firefox/Safari/iOS WebKit.
const CLIENT_HINTS_MIN_MAJOR = 89;

// GREASE brand rotates with the major version. Index = major % 3.
// This mirrors the values observed on Chromium 120/124/131; treat it as best-effort
// and prefer an exact capture (DEEPSEEK_FINGERPRINT_PATH) when a WAF is picky.
const GREASE_BRANDS = [
  { brand: "Not_A Brand", version: "8" },
  { brand: "Not-A.Brand", version: "99" },
  { brand: "Not)A;Brand", version: "24" },
];

const BRAND_ORDER = [
  ["grease", "chromium", "browser"],
  ["chromium", "browser", "grease"],
  ["browser", "chromium", "grease"],
];

// Credentials/one-shot headers that must never be captured into a fingerprint file.
export const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-ds-pow-response",
]);

// Transport-managed headers: letting a capture set these fights Node's fetch layer.
const DROPPED_HEADERS = new Set([
  ":authority",
  ":method",
  ":path",
  ":scheme",
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // undici owns compression even when we set the header; a stale capture value
  // (e.g. zstd on an older Node) can break decompression of the SSE stream.
  "accept-encoding",
]);

const CHROMIUM_BROWSERS = new Set(["chrome", "edge", "opera", "chromium"]);

function roundMajor(major) {
  const value = Number(major);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

export function detectPlatform(userAgent = "") {
  const ua = String(userAgent || "");
  if (/Windows NT/i.test(ua)) return { platform: "Windows", mobile: false };
  if (/Android/i.test(ua)) return { platform: "Android", mobile: true };
  if (/iPhone|iPod|iPad/i.test(ua)) return { platform: "iOS", mobile: true };
  if (/CrOS/i.test(ua)) return { platform: "Chrome OS", mobile: false };
  if (/Macintosh|Mac OS X/i.test(ua)) return { platform: "macOS", mobile: false };
  if (/Linux/i.test(ua)) return { platform: "Linux", mobile: false };
  return { platform: "Windows", mobile: false, guessed: true };
}

// Parse the UA captured at login. Order matters: Edge/Opera also contain "Chrome/x".
export function parseUserAgent(userAgent = DEFAULT_USER_AGENT) {
  const ua = String(userAgent || DEFAULT_USER_AGENT).trim();
  const edge = /Edg(?:A|iOS)?\/(\d+)/.exec(ua);
  const opera = /OPR\/(\d+)/.exec(ua);
  const iosChrome = /CriOS\/(\d+)/.exec(ua);
  const chrome = /Chrome\/(\d+)/.exec(ua);
  const firefox = /Firefox\/(\d+)/.exec(ua);
  const safari = /Version\/(\d+).*Safari/.exec(ua);

  let browser = "unknown";
  let browserMajor = null;
  if (edge) {
    browser = "edge";
    browserMajor = roundMajor(edge[1]);
  } else if (opera) {
    browser = "opera";
    browserMajor = roundMajor(opera[1]);
  } else if (iosChrome) {
    browser = "chrome-ios";
    browserMajor = roundMajor(iosChrome[1]);
  } else if (chrome) {
    browser = "chrome";
    browserMajor = roundMajor(chrome[1]);
  } else if (firefox) {
    browser = "firefox";
    browserMajor = roundMajor(firefox[1]);
  } else if (safari) {
    browser = "safari";
    browserMajor = roundMajor(safari[1]);
  }

  const { platform, mobile, guessed } = detectPlatform(ua);
  return {
    userAgent: ua,
    browser,
    browserMajor,
    platform,
    mobile,
    guessedPlatform: Boolean(guessed),
    chromium: CHROMIUM_BROWSERS.has(browser),
  };
}

function acceptLanguageFor(locale) {
  const value = String(locale || "").trim();
  if (!value) return "en-US,en;q=0.9";
  const [language, region] = value.replace("_", "-").split("-");
  if (!region) return language;
  return `${language}-${region},${language};q=0.9`;
}

function requestLocaleFor(locale) {
  return String(locale || "en-US").trim().replace("-", "_") || "en_US";
}

export function defaultTimezoneOffsetSeconds(date = new Date()) {
  return -date.getTimezoneOffset() * 60;
}

export function buildClientHints(parsed) {
  if (!parsed?.chromium || !parsed.browserMajor) return null;
  if (parsed.browserMajor < CLIENT_HINTS_MIN_MAJOR) return null;

  const major = String(parsed.browserMajor);
  const grease = GREASE_BRANDS[parsed.browserMajor % GREASE_BRANDS.length];
  const brandName =
    parsed.browser === "edge"
      ? "Microsoft Edge"
      : parsed.browser === "opera"
        ? "Opera"
        : "Google Chrome";
  const named = {
    grease: `"${grease.brand}";v="${grease.version}"`,
    chromium: `"Chromium";v="${major}"`,
    browser: `"${brandName}";v="${major}"`,
  };

  const order = BRAND_ORDER[parsed.browserMajor % BRAND_ORDER.length];
  const brands = order.map((key) => named[key]).join(", ");

  return {
    "sec-ch-ua": brands,
    "sec-ch-ua-mobile": parsed.mobile ? "?1" : "?0",
    "sec-ch-ua-platform": `"${parsed.platform}"`,
  };
}

function normalizeOrigin(origin) {
  const raw = String(origin || DEEPSEEK_ORIGIN).trim().replace(/\/+$/, "");
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return DEEPSEEK_ORIGIN;
    return url.origin;
  } catch {
    return DEEPSEEK_ORIGIN;
  }
}

function hostOf(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isDeepSeekHost(value) {
  const host = hostOf(value);
  return host === "deepseek.com" || host.endsWith(".deepseek.com");
}

// Build the fingerprint+same-origin header set. Credentials (cookie/authorization)
// and per-endpoint headers are added by the header layer, not here.
export function buildFingerprint(options = {}) {
  const warnings = [];
  const origin = normalizeOrigin(options.origin);
  const captured = options.capturedHeaders ? { ...options.capturedHeaders } : {};

  const userAgent =
    captured["user-agent"] || String(options.userAgent || "").trim() || DEFAULT_USER_AGENT;
  const parsed = parseUserAgent(userAgent);

  const locale =
    String(options.locale || process.env.DEEPSEEK_LOCALE || "en-US").trim() || "en-US";
  const acceptLanguage =
    String(options.acceptLanguage || "").trim() || acceptLanguageFor(locale);
  const timezoneOffsetSeconds = Number.isFinite(Number(options.timezoneOffsetSeconds))
    ? Math.trunc(Number(options.timezoneOffsetSeconds))
    : defaultTimezoneOffsetSeconds();
  const clientVersion = String(options.clientVersion || "2.7.0").trim() || "2.7.0";
  const bundleId = String(options.bundleId || "com.deepseek.chat").trim() || "com.deepseek.chat";
  const deviceId = String(options.deviceId || "").trim();

  // Chrome-ish request order for a same-origin JSON fetch from the web app.
  const headers = {
    accept: "application/json, text/plain, */*",
    "accept-encoding": "gzip, deflate, br",
    "accept-language": acceptLanguage,
    origin,
    priority: "u=1, i",
    referer: `${origin}/`,
  };

  const hints = buildClientHints(parsed);
  if (hints) Object.assign(headers, hints);

  Object.assign(headers, {
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": parsed.userAgent,
    "x-client-bundle-id": bundleId,
    "x-client-locale": requestLocaleFor(locale),
    "x-client-platform": "web",
    "x-client-timezone-offset": String(timezoneOffsetSeconds),
    "x-client-version": clientVersion,
    "x-device-id": deviceId,
    // The web client sends this header with an empty value; keep it for shape parity.
    "x-device-model": "",
  });

  // Exact capture wins over derived values, but only after sanitization.
  for (const [key, value] of Object.entries(captured)) {
    if (value === undefined || value === null) continue;
    headers[key] = String(value);
  }

  // Same-origin is a hard invariant: never forward a foreign Origin/Referer.
  if (headers.origin && !isDeepSeekHost(headers.origin)) {
    warnings.push(`capture origin 不是 DeepSeek：${headers.origin}（已回退）`);
    headers.origin = origin;
  }
  if (headers.referer && !isDeepSeekHost(headers.referer)) {
    warnings.push(`capture referer 不是 DeepSeek：${headers.referer}（已回退）`);
    headers.referer = `${headers.origin}/`;
  }
  if (!headers.referer.startsWith(`${headers.origin}/`)) {
    headers.referer = `${headers.origin}/`;
  }

  // Drop headers whose value would be invalid on the wire.
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") continue;
    if (/[\r\n]/.test(value)) {
      warnings.push(`header ${key} 含有换行，已丢弃`);
      delete headers[key];
    }
  }

  // Profile summary must describe the headers that will actually be sent, not the
  // pre-capture derivation (a capture may pin locale/timezone/version).
  const finalRequestLocale = headers["x-client-locale"] || requestLocaleFor(locale);
  const finalTimezone = Number(headers["x-client-timezone-offset"]);
  const source = Object.keys(captured).length > 0 ? "capture+derived" : "derived";
  const profile = {
    origin: headers.origin,
    referer: headers.referer,
    userAgent: headers["user-agent"],
    browser: parsed.browser,
    browserMajor: parsed.browserMajor,
    platform: parsed.platform,
    mobile: parsed.mobile,
    locale: finalRequestLocale.replace("_", "-"),
    requestLocale: finalRequestLocale,
    acceptLanguage: headers["accept-language"] || acceptLanguage,
    timezoneOffsetSeconds: Number.isFinite(finalTimezone) ? finalTimezone : timezoneOffsetSeconds,
    clientVersion: headers["x-client-version"] || clientVersion,
    bundleId: headers["x-client-bundle-id"] || bundleId,
    deviceId: headers["x-device-id"] || deviceId,
    headers,
    source,
    capturedAt: options.capturedAt || null,
    capturedSource: options.capturedSource || null,
    capturedHeaderCount: Object.keys(captured).length,
    warnings,
  };

  profile.warnings = [...warnings, ...validateFingerprint(profile)];
  return profile;
}

// Coherence checks used by tests and by /api/fingerprint. Returns human hints.
export function validateFingerprint(profile) {
  const warnings = [];
  if (!profile || typeof profile !== "object") return ["profile 为空"];

  const headers = profile.headers || {};
  const ua = headers["user-agent"] || "";
  const parsed = parseUserAgent(ua);

  if (!ua) warnings.push("缺少 user-agent");
  if (parsed.browser === "unknown") warnings.push("无法从 UA 识别浏览器（指纹会显得异常）");
  if (parsed.guessedPlatform) warnings.push("无法从 UA 识别平台，已回退为 Windows");

  const uaMajor = parsed.browserMajor;
  const chUa = headers["sec-ch-ua"] || "";
  const chMajorMatch = /v="(\d+)/.exec(chUa);
  if (chUa && uaMajor && chMajorMatch && Number(chMajorMatch[1]) !== uaMajor) {
    warnings.push(`UA 主版本 ${uaMajor} 与 sec-ch-ua ${chMajorMatch[1]} 不一致`);
  }
  if (parsed.chromium && uaMajor >= CLIENT_HINTS_MIN_MAJOR && !chUa) {
    warnings.push("Chromium 系 UA 缺少 sec-ch-ua");
  }
  if (!parsed.chromium && chUa) {
    warnings.push("非 Chromium 浏览器却发送 sec-ch-ua");
  }

  const chPlatform = (headers["sec-ch-ua-platform"] || "").replace(/"/g, "");
  if (chPlatform && chPlatform !== profile.platform) {
    warnings.push(`sec-ch-ua-platform ${chPlatform} 与 UA 平台 ${profile.platform} 不一致`);
  }
  const chMobile = headers["sec-ch-ua-mobile"];
  if (chMobile && Boolean(profile.mobile) !== (chMobile === "?1")) {
    warnings.push("sec-ch-ua-mobile 与 UA 的移动端标记不一致");
  }

  if (headers.origin && !isDeepSeekHost(headers.origin)) {
    warnings.push(`origin 不是 DeepSeek 域：${headers.origin}`);
  }
  if (headers.referer && !headers.referer.startsWith(`${headers.origin}/`)) {
    warnings.push("referer 与 origin 不同源");
  }
  if (headers["sec-fetch-site"] && headers["sec-fetch-site"] !== "same-origin") {
    warnings.push(`sec-fetch-site 不是 same-origin：${headers["sec-fetch-site"]}`);
  }
  if (headers["sec-fetch-mode"] && !/cors|same-origin/.test(headers["sec-fetch-mode"])) {
    warnings.push(`sec-fetch-mode 异常：${headers["sec-fetch-mode"]}`);
  }

  const tz = Number(profile.timezoneOffsetSeconds);
  if (!Number.isFinite(tz) || tz < -12 * 3600 || tz > 14 * 3600) {
    warnings.push(`timezone offset 超出范围：${profile.timezoneOffsetSeconds}`);
  }
  if (headers["x-client-timezone-offset"] !== String(profile.timezoneOffsetSeconds)) {
    warnings.push("x-client-timezone-offset 与 profile 不一致");
  }
  if (!/^[a-z]{2}([_-][A-Z]{2})?$/.test(headers["x-client-locale"] || "")) {
    warnings.push(`x-client-locale 格式异常：${headers["x-client-locale"]}`);
  }
  if (!profile.deviceId) {
    warnings.push("缺少 x-device-id（设备指纹不稳定）");
  } else if (!/^[0-9a-f-]{16,}$/i.test(profile.deviceId)) {
    warnings.push("x-device-id 不是 UUID 形态");
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) warnings.push(`header ${key} 为空值`);
    else if (/[\r\n]/.test(String(value))) warnings.push(`header ${key} 含换行`);
  }

  return warnings;
}

// Sanitize a DevTools/CDP captured header map so it can be replayed safely.
export function sanitizeCapturedHeaders(rawHeaders) {
  const headers = {};
  const dropped = [];

  for (const [rawKey, rawValue] of Object.entries(rawHeaders || {})) {
    const key = String(rawKey || "").trim().toLowerCase();
    if (!key) continue;
    if (key.startsWith(":") || DROPPED_HEADERS.has(key) || SENSITIVE_HEADERS.has(key)) {
      dropped.push(key);
      continue;
    }
    if (key.startsWith("x-hif-")) {
      // Risk tokens expire in ~10 minutes; the risk cache fetches fresh ones.
      dropped.push(key);
      continue;
    }
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
    if (!text) {
      dropped.push(key);
      continue;
    }
    headers[key] = text;
  }

  const origin = headers.origin;
  if (origin && (!isDeepSeekHost(origin) || !/^https:\/\//i.test(origin))) {
    dropped.push("origin");
    delete headers.origin;
  }
  const referer = headers.referer;
  if (referer && !isDeepSeekHost(referer)) {
    dropped.push("referer");
    delete headers.referer;
  }

  return { headers, dropped: [...new Set(dropped)] };
}

// Debug/status output must never leak the session.
export function redactHeaders(headers) {
  const safe = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    const text = String(value ?? "");
    if (SENSITIVE_HEADERS.has(lower) || lower.startsWith("x-hif-")) {
      safe[key] = text ? `<redacted:${text.length}>` : "<empty>";
    } else {
      safe[key] = text;
    }
  }
  return safe;
}
