// Orchestration tests: normalization, error mapping, auth lifecycle, tool loop, registry.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAuthManager } from "../src/orchestration/auth-manager.mjs";
import { BridgeError, ErrorCode } from "../src/orchestration/errors.mjs";
import { createFingerprintService } from "../src/orchestration/fingerprint-service.mjs";
import { createPipeline, mapUpstreamFailure } from "../src/orchestration/pipeline.mjs";
import {
  normalizeChatRequest,
  normalizeResponsesRequest,
  responsesToPrompt,
} from "../src/orchestration/request-normalizer.mjs";
import { createSessionStore } from "../src/orchestration/session-store.mjs";
import { createToolCallRegistry } from "../src/orchestration/tool-call-registry.mjs";
import { runToolLoop } from "../src/orchestration/tool-loop.mjs";
import { readConfig } from "../src/config.mjs";
import { createRuntime } from "../src/server.mjs";
import { UpstreamError, UpstreamErrorKind } from "../src/upstream-error.mjs";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`ok   - ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
}

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

async function captureError(generator) {
  try {
    for await (const _event of generator) {
      // drain
    }
  } catch (error) {
    return error;
  }
  return null;
}

const ctx = { requestId: "req-1", created: 1, model: "deepseek-web/deepseek-chat" };

function normalizerChecks() {
  const chat = normalizeChatRequest(
    {
      model: "deepseek-web/deepseek-chat",
      user: "session-a",
      messages: [{ role: "user", content: "halo" }],
    },
    { defaultModel: "fallback-model" },
  );
  check("normalize: chat session key", chat.sessionKey === "session-a");
  check("normalize: chat model", chat.model === "deepseek-web/deepseek-chat");
  check("normalize: chat prompt", chat.prompt.includes("user: halo"));
  check("normalize: chat tools default empty", Array.isArray(chat.tools) && chat.tools.length === 0);

  const chatWithTools = normalizeChatRequest(
    {
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object" } },
        },
      ],
    },
    { defaultModel: "m" },
  );
  check("normalize: chat tools extracted", chatWithTools.tools.length === 1);
  check("normalize: tool prompt included", chatWithTools.prompt.includes("get_weather"));

  const registry = createToolCallRegistry();
  registry.remember({ call_id: "call_1", name: "get_weather", type: "function_call" });

  const responses = normalizeResponsesRequest(
    {
      instructions: "be terse",
      previous_response_id: "resp_old",
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "sunny",
        },
      ],
    },
    {
      defaultModel: "m",
      lookupSession: (id) => (id === "resp_old" ? "session-from-previous" : undefined),
      lookupToolCall: (id) => registry.get(id),
    },
  );
  check("normalize: responses session via previous id", responses.sessionKey === "session-from-previous");
  check("normalize: instructions become system prompt", responses.prompt.includes("system: be terse"));
  check(
    "normalize: tool output labelled from registry",
    responses.prompt.includes("tool result from get_weather (call_1): sunny"),
    responses.prompt,
  );

  const promptOnly = responsesToPrompt({ input: "plain text" });
  check("normalize: string input prompt", promptOnly === "user: plain text");

  const defaults = normalizeResponsesRequest({}, { defaultModel: "m" });
  check("normalize: responses default session", defaults.sessionKey === "responses-default");
}

function registryChecks() {
  const registry = createToolCallRegistry({ limit: 2 });
  check("registry: remembers call", registry.remember({ call_id: "a", name: "one" })?.name === "one");
  registry.remember({ call_id: "b", name: "two" });
  registry.remember({ call_id: "c", name: "three" });
  check("registry: bounded size", registry.size() === 2);
  check("registry: evicts oldest", registry.get("a") === undefined && registry.get("c")?.name === "three");
  check("registry: ignores missing call id", registry.remember({ name: "x" }) === null);
}

function errorMappingChecks() {
  const rate = mapUpstreamFailure(
    new UpstreamError("too frequent", { kind: UpstreamErrorKind.RATE_LIMIT, status: 429 }),
    { phase: "upstream" },
  );
  check("map: rate limit code", rate instanceof BridgeError && rate.code === ErrorCode.RATE_LIMITED);
  check("map: rate limit retryable", rate.retryable === true);

  const waf = mapUpstreamFailure(
    new UpstreamError("blocked", { kind: UpstreamErrorKind.WAF, status: 403 }),
    { phase: "upstream" },
  );
  check("map: waf code", waf.code === ErrorCode.WAF_BLOCKED && waf.retryable === false);

  const protocol = mapUpstreamFailure(
    new UpstreamError("bad payload", { kind: UpstreamErrorKind.PROTOCOL }),
    { phase: "stream" },
  );
  check("map: protocol code", protocol.code === ErrorCode.UPSTREAM_STREAM_BROKEN);

  const session = mapUpstreamFailure(
    new UpstreamError("no id", { kind: UpstreamErrorKind.UPSTREAM }),
    { phase: "session" },
  );
  check("map: session create code", session.code === ErrorCode.SESSION_CREATE_FAILED);

  const aborted = mapUpstreamFailure(Object.assign(new Error("aborted"), { name: "AbortError" }), {
    phase: "stream",
  });
  check("map: abort -> cancelled", aborted.code === ErrorCode.CANCELLED);

  const timeout = mapUpstreamFailure(Object.assign(new Error("timeout"), { name: "TimeoutError" }), {
    phase: "upstream",
  });
  check("map: timeout code", timeout.code === ErrorCode.UPSTREAM_TIMEOUT && timeout.retryable === true);

  const passthrough = new BridgeError(ErrorCode.AUTH_MISSING, "no creds");
  check("map: bridge errors pass through", mapUpstreamFailure(passthrough) === passthrough);

  const unknown = mapUpstreamFailure(new Error("weird"), { phase: "upstream" });
  check("map: unknown -> upstream_error", unknown.code === ErrorCode.UPSTREAM_ERROR);
}

async function authChecks() {
  let creations = 0;
  const manager = createAuthManager({
    loadCredentials: async () => ({ cookie: "c", bearer: "b" }),
    createClient: async () => {
      creations += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { id: creations };
    },
    runLogin: async () => ({ cookie: "c2", bearer: "b2" }),
    summarize: () => ({ configured: true }),
    authPath: "/tmp/credentials.json",
  });

  const [first, second] = await Promise.all([manager.getClient(), manager.getClient()]);
  check("auth: concurrent cache miss creates once", creations === 1 && first === second);
  check("auth: cached client is peeked", manager.peek() === first);
  check("auth: credentials accessor", (await manager.getCredentials())?.cookie === "c");
  check("auth: summary accessor", (await manager.describeCredentials()).configured === true);

  await manager.login({});
  check("auth: login invalidates cache", manager.peek() === null);
  check("auth: auth path exposed", manager.authPath === "/tmp/credentials.json");

  let attempts = 0;
  const flaky = createAuthManager({
    loadCredentials: async () => ({ cookie: "c", bearer: "b" }),
    createClient: async () => {
      attempts += 1;
      if (attempts === 1) throw new UpstreamError("boom", { kind: UpstreamErrorKind.UPSTREAM });
      return { ok: true };
    },
  });
  const failure = await rejectionOf(flaky.getClient());
  check("auth: creation failure propagates", failure?.name === "UpstreamError");
  const recovered = await flaky.getClient();
  check("auth: failure is not cached", attempts === 2 && recovered.ok === true);

  const missing = createAuthManager({
    loadCredentials: async () => null,
    createClient: async () => ({ never: true }),
  });
  const missingError = await rejectionOf(missing.getClient());
  check(
    "auth: missing credentials -> auth_missing",
    missingError instanceof BridgeError && missingError.code === ErrorCode.AUTH_MISSING,
  );
}

async function pipelineChecks() {
  const sessionStore = createSessionStore();
  const sseBody = [
    'data: {"response_message_id":"msg-1"}',
    "",
    'data: {"p":"response/content","v":"Hello"}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const okClient = {
    createChatSession: async () => ({ chat_session_id: "sess-1" }),
    // The adapter returns a byte stream (res.body), not a Response object.
    chatCompletions: async () =>
      new Response(sseBody, { headers: { "content-type": "text/event-stream" } }).body,
  };
  const pipeline = createPipeline({
    authManager: { getClient: async () => okClient },
    sessionStore,
    defaultModel: "m",
    log: () => {},
  });

  const events = [];
  for await (const event of pipeline.runChatCompletion(
    { sessionKey: "k", model: "m", prompt: "hi" },
    ctx,
  )) {
    events.push(event);
  }
  check("pipeline: emits meta", events.some((event) => event.type === "meta"));
  check("pipeline: emits text", events.some((event) => event.type === "text_delta" && event.delta === "Hello"));
  check("pipeline: emits done", events.at(-1)?.type === "done");
  check(
    "pipeline: events carry ctx",
    events.every((event) => event.ctx === ctx),
  );
  check("pipeline: session cached", sessionStore.get("k")?.sessionId === "sess-1");

  const invalid = await captureError(
    pipeline.runChatCompletion({ sessionKey: "k", model: "m", prompt: "   " }, ctx),
  );
  check(
    "pipeline: empty prompt -> invalid_request",
    invalid?.code === ErrorCode.INVALID_REQUEST,
  );

  const rateManager = {
    getClient: async () => ({
      createChatSession: async () => ({ chat_session_id: "s" }),
      chatCompletions: async () => {
        throw new UpstreamError("too frequent", { kind: UpstreamErrorKind.RATE_LIMIT, status: 429 });
      },
    }),
  };
  const ratePipeline = createPipeline({
    authManager: rateManager,
    sessionStore: createSessionStore(),
    defaultModel: "m",
  });
  const rateError = await captureError(
    ratePipeline.runChatCompletion({ sessionKey: "r", model: "m", prompt: "hi" }, ctx),
  );
  check(
    "pipeline: upstream failure mapped",
    rateError?.code === ErrorCode.RATE_LIMITED && rateError.phase === "upstream",
  );

  const brokenManager = {
    getClient: async () => ({
      createChatSession: async () => ({ chat_session_id: "s" }),
      chatCompletions: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"Hi"}\n\n'));
              controller.error(new Error("socket hang up"));
            },
          }),
        ),
    }),
  };
  const brokenPipeline = createPipeline({
    authManager: brokenManager,
    sessionStore: createSessionStore(),
    defaultModel: "m",
  });
  const brokenError = await captureError(
    brokenPipeline.runChatCompletion({ sessionKey: "s", model: "m", prompt: "hi" }, ctx),
  );
  check(
    "pipeline: broken stream mapped",
    brokenError?.code === ErrorCode.UPSTREAM_STREAM_BROKEN && brokenError.phase === "stream",
  );
}

async function toolLoopChecks() {
  let calls = 0;
  const fakePipeline = {
    async *runChatCompletion() {
      calls += 1;
      yield { type: "text_delta", ctx, delta: "calling tool" };
    },
  };

  const toolEvents = [];
  for await (const event of runToolLoop({
    pipeline: fakePipeline,
    normalized: { prompt: "hi" },
    tools: [{ kind: "function", name: "get_weather" }],
    ctx,
    parseToolCall: () => ({
      id: "call_1",
      spec: { name: "get_weather", kind: "function" },
      arguments: '{"city":"Jakarta"}',
    }),
  })) {
    toolEvents.push(event);
  }
  check("tool-loop: forwards pipeline events", toolEvents[0]?.type === "text_delta");
  check("tool-loop: emits one tool call", toolEvents.filter((e) => e.type === "tool_call_done").length === 1);
  check(
    "tool-loop: tool payload intact",
    toolEvents.at(-1)?.payload?.name === "get_weather" &&
      toolEvents.at(-1)?.payload?.arguments?.includes("Jakarta"),
  );
  check("tool-loop: events carry ctx", toolEvents.every((event) => event.ctx === ctx));
  check("tool-loop: single-hop", calls === 1);

  calls = 0;
  const noTool = [];
  for await (const event of runToolLoop({
    pipeline: fakePipeline,
    normalized: {},
    tools: [{ kind: "function", name: "get_weather" }],
    ctx,
    parseToolCall: () => null,
  })) {
    noTool.push(event);
  }
  check("tool-loop: no tool call stops", noTool.every((event) => event.type !== "tool_call_done"));

  calls = 0;
  for await (const _event of runToolLoop({
    pipeline: fakePipeline,
    normalized: {},
    tools: [],
    ctx,
    parseToolCall: () => null,
  })) {
    // drain
  }
  check("tool-loop: no tools still streams once", calls === 1);
}

async function fingerprintServiceChecks() {
  const authDir = mkdtempSync(path.join(tmpdir(), "ds-fp-svc-"));
  const service = createFingerprintService({
    loadCredentials: async () => ({ cookie: "c", bearer: "b", userAgent: "" }),
    headerOptions: {
      env: {},
      authDir,
      deviceId: "99999999-8888-4777-8666-555555555555",
      riskHeaders: false,
    },
  });

  const credentials = { cookie: "c", bearer: "b", userAgent: "" };
  const first = service.describeFor(credentials);
  const second = service.describeFor(credentials);
  check("fingerprint-service: cached per credentials", first === second);
  check("fingerprint-service: origin", first.origin === "https://chat.deepseek.com");
  check(
    "fingerprint-service: credentials redacted",
    String(first.headers.cookie).startsWith("<redacted:") &&
      String(first.headers.authorization).startsWith("<redacted:") &&
      !JSON.stringify(first.headers).includes("Bearer "),
  );

  service.invalidate();
  const third = service.describeFor(credentials);
  check("fingerprint-service: invalidate rebuilds", third !== first);
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers || {};
      return this;
    },
    end(chunk) {
      if (chunk) this.body += String(chunk);
      this.writableEnded = true;
    },
    on() {},
    off() {},
  };
}

async function compositionRootChecks() {
  const authDir = mkdtempSync(path.join(tmpdir(), "ds-runtime-"));
  const config = readConfig({
    DEEPSEEK_AUTH_DIR: authDir,
    DEEPSEEK_DEVICE_ID: "77777777-6666-4555-8444-333333333333",
    DEEPSEEK_RISK_HEADERS: "0",
    DEEPSEEK_CDP_PORT: "9333",
  });

  let resolveLogin;
  const gate = new Promise((resolve) => {
    resolveLogin = resolve;
  });
  let loginCalls = 0;
  const fakeAuthManager = {
    login: async (options) => {
      loginCalls += 1;
      options?.onProgress?.("fake progress");
      await gate;
      return { cookie: "c", bearer: "b" };
    },
    getCredentials: async () => null,
    describeCredentials: async () => ({ configured: false }),
    peek: () => null,
    invalidate: () => {},
    authPath: "/tmp/fake-credentials.json",
  };

  const runtime = createRuntime(config, { authManager: fakeAuthManager });

  const loginResponse = fakeResponse();
  await runtime.handlers.login({}, loginResponse);
  check("runtime: login returns 202", loginResponse.statusCode === 202);
  check("runtime: login marks running", runtime.state.running === true);

  const duplicate = fakeResponse();
  await runtime.handlers.login({}, duplicate);
  check("runtime: duplicate login -> 409", duplicate.statusCode === 409);

  resolveLogin();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("runtime: login completes once", loginCalls === 1);
  check("runtime: running cleared", runtime.state.running === false);
  check(
    "runtime: login progress is streamed to logs",
    runtime.state.logs.some((entry) => entry.message === "fake progress"),
  );

  const chatTestResponse = fakeResponse();
  const emptyBodyRequest = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ message: "   " }));
    },
  };
  await runtime.handlers.chatTest(emptyBodyRequest, chatTestResponse);
  check("runtime: chat-test rejects empty message", chatTestResponse.statusCode === 400);

  const statusResponse = fakeResponse();
  await runtime.handlers.status({}, statusResponse);
  const status = JSON.parse(statusResponse.body);
  check("runtime: status reports models", status.gateway.models.length === config.models.length);
  check("runtime: status exposes header layer", Boolean(status.headers?.origin));
  check("runtime: status reports auth path", status.authPath === "/tmp/fake-credentials.json");

  const modelsResponse = fakeResponse();
  runtime.handlers.models({}, modelsResponse);
  check(
    "runtime: model list shape",
    JSON.parse(modelsResponse.body).data.every((entry) => entry.object === "model"),
  );

  const fingerprintResponse = fakeResponse();
  await runtime.handlers.fingerprint({}, fingerprintResponse);
  const fingerprint = JSON.parse(fingerprintResponse.body);
  check("runtime: fingerprint endpoint redacts credentials", !fingerprintResponse.body.includes("Bearer "));
  check("runtime: fingerprint endpoint reports origin", fingerprint.origin === "https://chat.deepseek.com");
}

normalizerChecks();
registryChecks();
errorMappingChecks();
await authChecks();
await pipelineChecks();
await toolLoopChecks();
await fingerprintServiceChecks();
await compositionRootChecks();

if (failures) {
  console.error(`\norchestration tests failed: ${failures} check(s)`);
  process.exit(1);
}
console.log("\norchestration tests passed");
