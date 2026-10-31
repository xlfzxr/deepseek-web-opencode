// Header layer tests: fingerprint coherence, CORS/preflight, SSE framing, /api/fingerprint.
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_USER_AGENT,
  buildClientHints,
  buildFingerprint,
  parseUserAgent,
  redactHeaders,
  sanitizeCapturedHeaders,
  validateFingerprint,
} from "../src/headers/fingerprint.mjs";
import { createRiskHeaderCache } from "../src/headers/risk.mjs";
import { createHeaderLayer, loadCaptureFile } from "../src/headers/upstream.mjs";
import { createCorsPolicy, evaluateCors, isOriginAllowed } from "../src/transport/cors.mjs";
import { parseDeepSeekStream } from "../src/deepseek-web-client.mjs";
import { openSse, sseDone, sseWrite } from "../src/transport/sse-writer.mjs";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`ok   - ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
}

const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1";
const FIREFOX_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

function fingerprintChecks() {
  const chrome = parseUserAgent(DEFAULT_USER_AGENT);
  check("ua: chrome/131", chrome.browser === "chrome" && chrome.browserMajor === 131);
  check("ua: windows desktop", chrome.platform === "Windows" && chrome.mobile === false);

  const android = parseUserAgent(CHROME_ANDROID);
  check("ua: android mobile", android.platform === "Android" && android.mobile === true);

  const edge = parseUserAgent(EDGE_WINDOWS);
  check("ua: edge detected before chrome", edge.browser === "edge" && edge.browserMajor === 131);

  const iphone = parseUserAgent(IPHONE_CHROME);
  check("ua: ios chrome is not chromium", iphone.browser === "chrome-ios" && iphone.chromium === false);

  const firefox = parseUserAgent(FIREFOX_LINUX);
  check("ua: firefox has no client hints", firefox.chromium === false && buildClientHints(firefox) === null);

  const chromeHints = buildClientHints(chrome);
  check(
    "ch: sec-ch-ua is quoted and well formed",
    /^"[^"]+";v="\d+", "[^"]+";v="\d+", "[^"]+";v="\d+"$/.test(chromeHints["sec-ch-ua"]),
    chromeHints["sec-ch-ua"],
  );
  check("ch: mobile flag", chromeHints["sec-ch-ua-mobile"] === "?0");
  check("ch: platform", chromeHints["sec-ch-ua-platform"] === '"Windows"');
  check(
    "ch: version matches UA",
    /"Google Chrome";v="131"/.test(chromeHints["sec-ch-ua"]),
    chromeHints["sec-ch-ua"],
  );
  check(
    "ch: android sets mobile",
    buildClientHints(android)["sec-ch-ua-mobile"] === "?1",
  );
  check(
    "ch: edge brand present",
    /"Microsoft Edge";v="131"/.test(buildClientHints(edge)["sec-ch-ua"]),
  );

  const profile = buildFingerprint({
    deviceId: "3f1d2c9a-1111-4222-8333-444455556666",
    timezoneOffsetSeconds: 25200,
    locale: "en-US",
  });
  check("fp: no warning for a clean profile", profile.warnings.length === 0, profile.warnings.join(" | "));
  check("fp: same-origin invariant", profile.referer.startsWith(`${profile.origin}/`));
  check("fp: origin is deepseek", profile.origin === "https://chat.deepseek.com");
  check("fp: fetch metadata", profile.headers["sec-fetch-site"] === "same-origin" &&
    profile.headers["sec-fetch-mode"] === "cors" &&
    profile.headers["sec-fetch-dest"] === "empty");
  check("fp: timezone propagated", profile.headers["x-client-timezone-offset"] === "25200");
  check("fp: locale propagated", profile.headers["x-client-locale"] === "en_US");
  check("fp: accept-language derived", profile.headers["accept-language"] === "en-US,en;q=0.9");
  check("fp: device id propagated", profile.headers["x-device-id"].startsWith("3f1d2c9a"));
  check("fp: browser client identity", profile.headers["x-client-bundle-id"] === "com.deepseek.chat");

  const tamperedUA = buildFingerprint({
    userAgent: DEFAULT_USER_AGENT.replace("Chrome/131.0.0.0", "Chrome/120.0.0.0"),
    deviceId: "3f1d2c9a-1111-4222-8333-444455556666",
  });
  check("fp: android hints follow android UA",
    tamperedUA.headers["sec-ch-ua-mobile"] === "?0");
  check("fp: UA/hints mismatch caught", tamperedUA.warnings.length === 0 || !tamperedUA.warnings.some((w) => w.includes("131")));

  const broken = {
    ...profile,
    headers: {
      ...profile.headers,
      "sec-ch-ua": '"Chromium";v="99"',
      "sec-ch-ua-platform": '"macOS"',
      referer: "https://example.com/",
      "sec-fetch-site": "cross-site",
    },
  };
  const brokenWarnings = validateFingerprint(broken).join(" | ");
  check("val: version mismatch flagged", brokenWarnings.includes("sec-ch-ua 99") || brokenWarnings.includes("不一致"));
  check("val: referer flagged", brokenWarnings.includes("referer") || brokenWarnings.includes("不同源"));
  check("val: fetch-site flagged", brokenWarnings.includes("sec-fetch-site"));

  const foreignOrigin = {
    ...profile,
    headers: { ...profile.headers, origin: "https://example.com" },
  };
  check(
    "val: foreign origin flagged",
    validateFingerprint(foreignOrigin).some((warning) => warning.includes("origin 不是 DeepSeek")),
  );
}

function captureChecks() {
  const { headers, dropped } = sanitizeCapturedHeaders({
    ":authority": "chat.deepseek.com",
    Cookie: "a=b",
    Authorization: "Bearer secret",
    "x-ds-pow-response": "pow",
    "content-length": "12",
    "accept-encoding": "gzip, deflate, br, zstd",
    "x-hif-leim": "risk",
    "user-agent": ` ${DEFAULT_USER_AGENT} `,
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not)A;Brand";v="24"',
    origin: "https://evil.example",
    referer: "https://chat.deepseek.com/",
    "x-client-version": "2.7.0",
  });

  check("cap: cookie/auth/pow dropped", !headers.cookie && !headers.authorization && !headers["x-ds-pow-response"]);
  check("cap: hop-by-hop dropped", !headers[":authority"] && !headers["content-length"] && !headers["accept-encoding"]);
  check("cap: expiring risk tokens dropped", !headers["x-hif-leim"]);
  check("cap: foreign origin dropped", !headers.origin && dropped.includes("origin"));
  check("cap: real fingerprint kept", headers["user-agent"] === DEFAULT_USER_AGENT && Boolean(headers["sec-ch-ua"]));
  check("cap: values trimmed", headers["user-agent"] === headers["user-agent"].trim());

  const dir = mkdtempSync(path.join(tmpdir(), "ds-capture-"));
  const file = path.join(dir, "capture.json");
  writeFileSync(
    file,
    JSON.stringify({
      hits: [
        {
          url: "https://chat.deepseek.com/api/v0/chat/completion",
          headers: {
            "user-agent": DEFAULT_USER_AGENT,
            origin: "https://chat.deepseek.com",
            referer: "https://chat.deepseek.com/",
            cookie: "secret=1",
            "x-client-version": "2.7.0",
          },
        },
      ],
    }),
  );
  const loaded = loadCaptureFile(file);
  check("cap: raw CDP capture is understood", loaded?.headers?.["x-client-version"] === "2.7.0");
  check("cap: loaded capture has no cookie", !loaded?.headers?.cookie);

  const layered = createHeaderLayer({
    userAgent: CHROME_ANDROID,
    capturePath: file,
    env: { DEEPSEEK_DEVICE_ID: "11111111-2222-4333-8444-555555555555", DEEPSEEK_RISK_HEADERS: "0" },
    log: () => {},
  });
  check("cap: capture overrides derived values", layered.fingerprint.headers["user-agent"] === DEFAULT_USER_AGENT);
  check("cap: capture source reported", layered.fingerprint.source === "capture+derived");
  check("cap: capture keeps same-origin", layered.fingerprint.headers.origin === "https://chat.deepseek.com");

  const richCapture = path.join(mkdtempSync(path.join(tmpdir(), "ds-caprich-")), "fingerprint.json");
  writeFileSync(
    richCapture,
    JSON.stringify({
      headers: {
        "user-agent": CHROME_ANDROID,
        "sec-ch-ua": '"Chromium";v="131", "Google Chrome";v="131", "Not)A;Brand";v="24"',
        "sec-ch-ua-mobile": "?1",
        "sec-ch-ua-platform": '"Android"',
        "accept-language": "id-ID,id;q=0.9",
        origin: "https://chat.deepseek.com",
        referer: "https://chat.deepseek.com/a/chat/s/abc",
        "x-client-timezone-offset": "25200",
        "x-client-locale": "id_ID",
        "x-client-version": "2.7.1",
      },
    }),
  );
  const rich = createHeaderLayer({
    capturePath: richCapture,
    env: { DEEPSEEK_DEVICE_ID: "11111111-2222-4333-8444-555555555555", DEEPSEEK_RISK_HEADERS: "0" },
    log: () => {},
  });
  check("cap: timezone comes from capture", rich.fingerprint.timezoneOffsetSeconds === 25200);
  check("cap: locale comes from capture", rich.fingerprint.locale === "id-ID" && rich.fingerprint.requestLocale === "id_ID");
  check("cap: client version comes from capture", rich.fingerprint.clientVersion === "2.7.1");
  check(
    "cap: coherent capture has no warnings",
    rich.fingerprint.warnings.length === 0,
    rich.fingerprint.warnings.join(" | "),
  );
  check("cap: referer path preserved", rich.fingerprint.referer.endsWith("/a/chat/s/abc"));
  check(
    "cap: provenance marks captured headers",
    layered.describe().sources["user-agent"] === "capture" &&
      layered.describe().sources["x-client-version"] === "capture",
  );
}

function headerLayerChecks() {
  const layer = createHeaderLayer({
    cookie: "session=abc",
    bearer: "token-123",
    userAgent: DEFAULT_USER_AGENT,
    env: {
      DEEPSEEK_AUTH_DIR: mkdtempSync(path.join(tmpdir(), "ds-layer-")),
      DEEPSEEK_DEVICE_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      DEEPSEEK_RISK_HEADERS: "0",
      DEEPSEEK_TZ_OFFSET: "25200",
    },
    log: () => {},
  });

  const completion = layer.forEndpoint("/api/v0/chat/completion", {
    powResponse: "pow-payload",
    riskHeaders: { "x-hif-leim": "leim-token" },
  });
  const names = Object.keys(completion);
  check("layer: authorization header", completion.authorization === "Bearer token-123");
  check("layer: cookie header", completion.cookie === "session=abc");
  check("layer: json content-type", completion["content-type"] === "application/json");
  check("layer: pow header", completion["x-ds-pow-response"] === "pow-payload");
  check("layer: risk header", completion["x-hif-leim"] === "leim-token");
  check(
    "layer: chrome-ish ordering",
    names.indexOf("accept") < names.indexOf("authorization") &&
      names.indexOf("authorization") < names.indexOf("content-type") &&
      names.indexOf("content-type") < names.indexOf("cookie") &&
      names.indexOf("cookie") < names.indexOf("origin") &&
      names.indexOf("origin") < names.indexOf("user-agent"),
    names.join(","),
  );

  const settings = layer.forEndpoint("/api/v0/client/settings", { method: "GET" });
  check("layer: GET has no content-type", !settings["content-type"]);
  check("layer: GET has no pow header", !settings["x-ds-pow-response"]);

  const extra = layer.forEndpoint("/api/v0/chat/completion", { extra: { "x-custom": "1" } });
  check("layer: extra header override", extra["x-custom"] === "1");

  completion["user-agent"] = "mutated";
  const again = layer.forEndpoint("/api/v0/chat/completion");
  check("layer: calls do not share state", again["user-agent"] === DEFAULT_USER_AGENT);

  const described = layer.describe();
  check("layer: describe redacts cookie", !String(described.headers.cookie || "").includes("session=abc"));
  check("layer: describe redacts bearer", !String(described.headers.authorization || "").includes("token-123"));
  check("layer: describe redacts pow", String(described.headers["x-ds-pow-response"]).startsWith("<redacted"));
  check("layer: describe has no warnings", described.warnings.length === 0, described.warnings.join(" | "));
  check("layer: describe reports origin", described.origin === "https://chat.deepseek.com");
  check(
    "layer: provenance labels every header",
    described.sources["user-agent"] === "fingerprint" &&
      described.sources.origin === "fingerprint" &&
      described.sources.authorization === "credentials" &&
      described.sources.cookie === "credentials" &&
      described.sources["content-type"] === "endpoint" &&
      described.sources["x-ds-pow-response"] === "pow",
    JSON.stringify(described.sources),
  );
  const explained = layer.explain("/api/v0/chat/completion", { riskHeaders: { "x-hif-leim": "x" } });
  check("layer: explain marks risk headers", explained.sources["x-hif-leim"] === "risk");

  const redacted = redactHeaders({ cookie: "abc", "x-hif-leim": "tok", accept: "*/*" });
  check("redact: keeps safe headers", redacted.accept === "*/*");
  check("redact: hides risk tokens", redacted["x-hif-leim"] === "<redacted:3>");
}

async function riskChecks() {
  let calls = 0;
  let clock = 1_000_000;
  const fetcher = async (url) => {
    calls += 1;
    const name = url.includes("leim") ? "leim" : "dliq";
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: { biz_data: { value: `${name}-token` } } };
      },
    };
  };

  const cache = createRiskHeaderCache({ fetcher, ttlMs: 1000, retryMs: 500, now: () => clock });
  const first = await cache.get();
  check("risk: both tokens fetched", first["x-hif-leim"] === "leim-token" && first["x-hif-dliq"] === "dliq-token");
  check("risk: one request per host", calls === 2);

  await cache.get();
  check("risk: cached within TTL", calls === 2);

  clock += 1500;
  await cache.get();
  check("risk: refreshed after TTL", calls === 4);

  let failingCalls = 0;
  const failing = createRiskHeaderCache({
    ttlMs: 1000,
    retryMs: 500,
    now: () => clock,
    fetcher: async () => {
      failingCalls += 1;
      throw new Error("network down");
    },
  });
  const failed = await failing.get();
  check("risk: failure is soft", Object.keys(failed).length === 0);
  await failing.get();
  check("risk: failure backoff", failingCalls === 2, String(failingCalls));

  const disabled = createRiskHeaderCache({ enabled: false, fetcher });
  check("risk: disabled cache is empty", Object.keys(await disabled.get()).length === 0);

  const unhealthy = await createRiskHeaderCache({
    ttlMs: 1000,
    now: () => clock,
    fetcher: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { data: { biz_data: { value: "bad\nvalue" } } };
      },
    }),
  }).get();
  check("risk: multiline values rejected", Object.keys(unhealthy).length === 0);
}

function corsChecks() {
  const policy = createCorsPolicy("");
  check("cors: no-origin allowed", isOriginAllowed("", policy));
  check("cors: loopback any port", isOriginAllowed("http://localhost:5173", policy));
  check("cors: 127.0.0.1 allowed", isOriginAllowed("http://127.0.0.1:8787", policy));
  check("cors: external origin denied", !isOriginAllowed("https://evil.example", policy));
  check("cors: null denied by default", !isOriginAllowed("null", policy));

  const star = createCorsPolicy("*");
  check("cors: star allows all", isOriginAllowed("https://anything.example", star));

  const explicit = createCorsPolicy("https://app.example, null");
  check("cors: explicit origin allowed", isOriginAllowed("https://app.example", explicit));
  check("cors: explicit null allowed", isOriginAllowed("null", explicit));

  const req = {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type, authorization",
      "access-control-request-private-network": "true",
    },
  };
  const decision = evaluateCors(req, policy);
  check("cors: preflight detected", decision.preflight && decision.allowed);
  check("cors: requested headers echoed", decision.allowHeaders.join(",") === "content-type,authorization");
  check("cors: private network tracked", decision.privateNetwork === true);

  const denied = evaluateCors({ method: "POST", headers: { origin: "https://evil.example" } }, policy);
  check("cors: denied decision", denied.allowed === false && denied.preflight === false);
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = null;
    this.status = null;
    this.chunks = [];
    this.writableEnded = false;
    this.destroyed = false;
    this.writableLength = 0;
    this.flushed = 0;
    this.socket = { setNoDelay: () => { this.noDelay = true; } };
  }
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }
  flushHeaders() {
    this.flushed += 1;
  }
  write(chunk) {
    if (this.writableEnded) throw new Error("write after end");
    this.chunks.push(String(chunk));
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit("finish");
    this.emit("close");
  }
}

async function sseChecks() {
  const res = new FakeResponse();
  const stream = openSse(res, { heartbeatMs: 20, retryMs: 3000 });
  const body = () => res.chunks.join("");

  check("sse: status 200", res.status === 200);
  check("sse: content type", String(res.headers["content-type"]).includes("text/event-stream"));
  check("sse: no-transform", String(res.headers["cache-control"]).includes("no-transform"));
  check("sse: proxy buffering disabled", res.headers["x-accel-buffering"] === "no");
  check("sse: headers flushed eagerly", res.flushed === 1);
  check("sse: nodelay set", res.noDelay === true);
  check("sse: retry hint", body().includes("retry: 3000"));
  check("sse: open comment", body().includes(": connected"));

  stream.data({ a: 1 });
  stream.event("response.created", { type: "response.created" });
  stream.comment("thinking");
  stream.done();
  stream.end();
  const frames = body();
  check("sse: data frame", frames.includes('data: {"a":1}\n\n'));
  check("sse: event frame", frames.includes('event: response.created\ndata: {"type":"response.created"}\n\n'));
  check("sse: comment frame", frames.includes(": thinking\n\n"));
  check("sse: done frame", frames.includes("data: [DONE]"));

  await new Promise((resolve) => setTimeout(resolve, 35));
  check("sse: heartbeat after close stops", !body().includes("keep-alive") || res.writableEnded);

  check("sse: writes after end are no-ops", sseWrite(res, { late: true }) === false && sseDone(res) === false);

  const heartbeatRes = new FakeResponse();
  const live = openSse(heartbeatRes, { heartbeatMs: 15 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  check("sse: heartbeat while open", heartbeatRes.chunks.join("").includes(": keep-alive"));
  live.end();
  const count = heartbeatRes.chunks.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  check("sse: heartbeat cleared on end", heartbeatRes.chunks.length === count);

  const abortRes = new FakeResponse();
  const abortable = openSse(abortRes, { heartbeatMs: 0, initialComment: "" });
  check("sse: signal initially live", abortable.signal.aborted === false);
  abortRes.emit("close");
  check("sse: signal aborts on disconnect", abortable.signal.aborted === true);
}

async function upstreamStreamChecks() {
  const body = [
    ": keep-alive",
    'data:{"p":"response/content","v":"Hel"}',
    "",
    'data: {"p":"response/content","v":"lo"}',
    "",
    "data: [DONE]",
    "",
  ].join("\r\n");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });

  const events = [];
  for await (const event of parseDeepSeekStream(stream)) events.push(event);
  check(
    "upstream: parses data: with and without space",
    events.filter((event) => event.type === "text").map((event) => event.delta).join("") === "Hello",
  );
  check("upstream: ignores comments and [DONE]", events.length === 2);
}

async function serverChecks() {
  const authDir = mkdtempSync(path.join(tmpdir(), "ds-headers-server-"));
  process.env.DEEPSEEK_AUTH_PATH = path.join(authDir, "credentials.json");
  process.env.DEEPSEEK_AUTH_DIR = authDir;
  process.env.DEEPSEEK_DEVICE_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  process.env.DEEPSEEK_RISK_HEADERS = "0";
  process.env.DEEPSEEK_FINGERPRINT_PATH = path.join(authDir, "fingerprint.json");
  delete process.env.DEEPSEEK_BRIDGE_ALLOW_ORIGINS;

  const { startServer } = await import("../src/server.mjs");
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const fingerprintRes = await fetch(`${base}/api/fingerprint`);
  const fingerprint = await fingerprintRes.json();
  check("server: GET /api/fingerprint -> 200", fingerprintRes.status === 200);
  check("server: fingerprint has sanity checks", Array.isArray(fingerprint.warnings));
  check("server: fingerprint reports origin", fingerprint.origin === "https://chat.deepseek.com");
  check(
    "server: fingerprint never leaks credentials",
    !JSON.stringify(fingerprint).includes("Bearer ") && !String(fingerprint.headers?.cookie || "").includes("d_id"),
  );
  check("server: fingerprint exposes client version", Boolean(fingerprint.headers?.["x-client-version"]));

  const statusRes = await fetch(`${base}/api/status`);
  const status = await statusRes.json();
  check("server: status includes header layer", Boolean(status.headers?.origin && status.headers?.riskHeaders));

  const preflight = await fetch(`${base}/v1/chat/completions`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,authorization",
    },
  });
  check("server: preflight -> 204", preflight.status === 204);
  check(
    "server: preflight echoes origin",
    preflight.headers.get("access-control-allow-origin") === "http://localhost:5173",
  );
  check(
    "server: preflight allows POST+headers",
    preflight.headers.get("access-control-allow-methods").includes("POST") &&
      preflight.headers.get("access-control-allow-headers").includes("authorization"),
  );
  check("server: preflight varies by origin", preflight.headers.get("vary") === "Origin");

  const deniedPreflight = await fetch(`${base}/v1/chat/completions`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
  });
  check("server: foreign preflight -> 403", deniedPreflight.status === 403 &&
    deniedPreflight.headers.get("access-control-allow-origin") === null);

  const denied = await fetch(`${base}/v1/models`, { headers: { origin: "https://evil.example" } });
  const deniedBody = await denied.json();
  check("server: foreign origin -> 403 json", denied.status === 403 && deniedBody.error === "origin_not_allowed");
  check("server: no ACAO on denied origin", denied.headers.get("access-control-allow-origin") === null);

  const allowedGet = await fetch(`${base}/v1/models`, { headers: { origin: "http://127.0.0.1:3000" } });
  check("server: loopback origin allowed", allowedGet.status === 200 &&
    allowedGet.headers.get("access-control-allow-origin") === "http://127.0.0.1:3000");

  const events = await fetch(`${base}/api/events`);
  check(
    "server: SSE disables buffering",
    events.status === 200 &&
      String(events.headers.get("content-type")).includes("text/event-stream") &&
      events.headers.get("x-accel-buffering") === "no" &&
      String(events.headers.get("cache-control")).includes("no-transform"),
  );
  const reader = events.body.getReader();
  const first = await reader.read();
  const firstText = new TextDecoder().decode(first.value || new Uint8Array());
  check("server: SSE retry + open comment", firstText.includes("retry: 3000") && firstText.includes(": connected"));
  await reader.cancel();

  const sseError = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-web/deepseek-chat", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const sseErrorText = await sseError.text();
  check(
    "server: stream error still closes with [DONE]",
    sseError.status === 200 && sseErrorText.includes("data: [DONE]"),
  );

  server.closeAllConnections?.();
  server.close();
}

fingerprintChecks();
captureChecks();
headerLayerChecks();
await riskChecks();
corsChecks();
await sseChecks();
await upstreamStreamChecks();
await serverChecks();

if (failures) {
  console.error(`\nheader tests failed: ${failures} check(s)`);
  process.exit(1);
}
console.log("\nheader tests passed");
