// Composition root: bootstrap + route wiring only. Business logic lives in orchestration.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readConfig } from "./config.mjs";
import { createAuthManager } from "./orchestration/auth-manager.mjs";
import { ErrorCode } from "./orchestration/errors.mjs";
import { createFingerprintService } from "./orchestration/fingerprint-service.mjs";
import { createPipeline } from "./orchestration/pipeline.mjs";
import { createProviderClient } from "./orchestration/provider-client.mjs";
import {
  normalizeChatRequest,
  normalizeResponsesRequest,
} from "./orchestration/request-normalizer.mjs";
import { createSessionStore } from "./orchestration/session-store.mjs";
import { createToolCallRegistry } from "./orchestration/tool-call-registry.mjs";
import { parseToolCallFromText } from "./orchestration/tool-parser.mjs";
import { runToolLoop } from "./orchestration/tool-loop.mjs";
import { createCorsPolicy } from "./transport/cors.mjs";
import { createRequestAbort, readJsonBody, sendJson } from "./transport/http.mjs";
import { chatCompletionJson, responsesJson } from "./transport/openai-json.mjs";
import {
  writeChatChunk,
  writeChatFinish,
  writeChatToolCall,
  writeResponseCompleted,
  writeResponseStart,
  writeResponseTextDelta,
  writeResponseTextDone,
  writeResponseTextStart,
  writeResponseToolCall,
} from "./transport/openai-sse.mjs";
import { createRouter } from "./transport/router.mjs";
import { openSse, sseDone, sseWrite } from "./transport/sse-writer.mjs";

export { parseToolCallFromText };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

function nowStamp() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

export function createRuntime(config = readConfig(), deps = {}) {
  const state = {
    running: false,
    lastError: "",
    logs: [],
    clients: new Set(),
  };

  let listenPort = config.port;
  const chatSessions = createSessionStore();
  const responseSessions = createSessionStore();
  const toolCalls = createToolCallRegistry();

  function pushLog(message, level = "info") {
    const entry = {
      id: Date.now() + Math.random(),
      at: nowStamp(),
      level,
      message,
    };
    state.logs.push(entry);
    state.logs = state.logs.slice(-120);
    for (const client of state.clients) {
      client.data(entry);
    }
    console.log(`[ui] ${message}`);
  }

  // `deps` is a test seam for the composition root only; production passes nothing.
  const authManager =
    deps.authManager ||
    createAuthManager({
      createClient: (credentials) =>
        createProviderClient(credentials, {
          headerOptions: config.header,
          log: pushLog,
        }),
    });

  const pipeline = createPipeline({
    authManager,
    sessionStore: chatSessions,
    log: pushLog,
    defaultModel: config.models[0],
  });

  const fingerprint = createFingerprintService({
    loadCredentials: () => authManager.getCredentials(),
    headerOptions: config.header,
  });

  async function statusPayload() {
    const [credentials, summary, headers] = await Promise.all([
      authManager.getCredentials(),
      authManager.describeCredentials(),
      fingerprint.describe(authManager.peek()),
    ]);

    return {
      running: state.running,
      lastError: state.lastError,
      authPath: authManager.authPath,
      gateway: {
        baseUrl: `http://127.0.0.1:${listenPort}/v1`,
        apiKey: config.apiKeyHint,
        responsesEndpoint: "/v1/responses",
        chatEndpoint: "/v1/chat/completions",
        models: [...config.models],
        toolCalling: {
          enabled: true,
          strategy: "prompt-xml-to-responses-events",
          events: [
            "response.function_call_arguments.done",
            "response.custom_tool_call_input.done",
          ],
        },
      },
      credentials: {
        ...summary,
        configured: Boolean(credentials?.cookie && credentials?.bearer),
      },
      headers: {
        origin: headers.origin,
        browser: headers.browser === "unknown" ? "unknown" : `${headers.browser}/${headers.browserMajor}`,
        platform: headers.platform,
        source: headers.source,
        deviceSource: headers.deviceSource,
        riskHeaders: headers.risk,
        warnings: headers.warnings.length,
      },
      recentLogs: state.logs.slice(-50),
    };
  }

  async function startLogin(res) {
    if (state.running) {
      sendJson(res, 409, { ok: false, error: "login_already_running" });
      return;
    }

    state.running = true;
    state.lastError = "";
    pushLog("登录流程已启动。");
    sendJson(res, 202, { ok: true });

    void authManager
      .login({
        port: config.auth.cdpPort,
        onProgress: (message) => pushLog(message),
      })
      .then(() => {
        fingerprint.invalidate();
        pushLog("凭证已保存，可以测试对话。");
      })
      .catch((error) => {
        state.lastError = error?.message || String(error);
        pushLog(state.lastError, "error");
      })
      .finally(() => {
        state.running = false;
      });
  }

  // UI log stream: EventSource with retry hint + heartbeat so it survives idle proxies.
  async function handleSse(req, res) {
    const stream = openSse(res, {
      retryMs: 3000,
      heartbeatMs: config.sse.heartbeatMs,
      initialComment: "connected",
    });
    for (const entry of state.logs.slice(-30)) {
      stream.data(entry);
    }
    state.clients.add(stream);
    stream.onClose(() => {
      state.clients.delete(stream);
    });
    req.on("close", () => {
      state.clients.delete(stream);
    });
  }

  function modelPayload() {
    return {
      object: "list",
      data: config.models.map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "deepseek-web",
      })),
    };
  }

  async function streamChatCompletions(res, body, options = {}) {
    const normalized = normalizeChatRequest(body, { defaultModel: config.models[0] });
    const stream = openSse(res, { heartbeatMs: config.sse.heartbeatMs });
    const signal = options.signal || stream.signal;

    const requestId = `chatcmpl-ds-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = normalized.model;
    const ctx = { requestId, created, model };

    let fullText = "";
    if (normalized.tools.length) {
      for await (const event of runToolLoop({
        pipeline,
        normalized,
        tools: normalized.tools,
        ctx,
        signal,
        parseToolCall: parseToolCallFromText,
      })) {
        if (event.type === "text_delta" && event.delta) fullText += event.delta;
        if (event.type !== "tool_call_done") continue;

        writeChatToolCall(res, {
          requestId,
          created,
          model,
          toolCall: {
            id: event.payload.id,
            spec: event.payload.spec,
            arguments: event.payload.arguments,
          },
        });
        pushLog(`DeepSeek Web requested chat tool: ${event.payload.name}`);
        sseDone(res);
        res.end();
        return;
      }
      if (fullText) {
        writeChatChunk(res, { requestId, created, model, delta: { content: fullText } });
      }
    } else {
      for await (const event of pipeline.runChatCompletion(normalized, ctx, signal)) {
        const delta = event.delta ?? "";
        if (!delta || (event.type !== "text_delta" && event.type !== "reasoning_delta")) continue;
        writeChatChunk(res, {
          requestId,
          created,
          model,
          delta:
            event.type === "reasoning_delta"
              ? { reasoning_content: delta }
              : { content: delta },
        });
      }
    }

    writeChatFinish(res, { requestId, created, model, finishReason: "stop" });
    sseDone(res);
    res.end();
  }

  async function jsonChatCompletions(res, body, options = {}) {
    const normalized = normalizeChatRequest(body, { defaultModel: config.models[0] });
    const requestId = `chatcmpl-ds-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = normalized.model;
    const ctx = { requestId, created, model };

    let content = "";
    for await (const event of pipeline.runChatCompletion(normalized, ctx, options.signal)) {
      if (event.type === "text_delta" && event.delta) content += event.delta;
    }

    const toolCall = normalized.tools.length
      ? parseToolCallFromText(content, normalized.tools)
      : null;
    if (toolCall) pushLog(`DeepSeek Web requested chat tool: ${toolCall.spec.name}`);

    sendJson(
      res,
      200,
      chatCompletionJson({ requestId, created, model, content, toolCall }),
    );
  }

  async function streamResponses(res, body, options = {}) {
    const normalized = normalizeResponsesRequest(body, {
      defaultModel: config.models[0],
      lookupSession: (id) => responseSessions.get(id),
      lookupToolCall: (id) => toolCalls.get(id),
      remember: (item) => toolCalls.remember(item),
    });

    const responseId = `resp_ds_${Date.now()}`;
    const model = normalized.model;
    const ctx = { requestId: responseId, created: Math.floor(Date.now() / 1000), model };
    responseSessions.set(responseId, normalized.sessionKey);

    const stream = openSse(res, { heartbeatMs: config.sse.heartbeatMs });
    const signal = options.signal || stream.signal;

    writeResponseStart(res, responseId, model);
    let textStarted = false;
    let fullText = "";

    const upstream = normalized.tools.length
      ? runToolLoop({
          pipeline,
          normalized,
          tools: normalized.tools,
          ctx,
          signal,
          parseToolCall: parseToolCallFromText,
        })
      : pipeline.runChatCompletion(normalized, ctx, signal);

    for await (const event of upstream) {
      if (event.type !== "text_delta" && event.type !== "reasoning_delta") continue;
      const delta = event.delta ?? "";
      if (!delta) continue;
      if (normalized.tools.length) {
        if (event.type === "text_delta") fullText += delta;
        continue;
      }
      if (event.type === "reasoning_delta") continue;
      if (!textStarted) {
        writeResponseTextStart(res, responseId);
        textStarted = true;
      }
      fullText += delta;
      writeResponseTextDelta(res, responseId, delta);
    }

    const toolCall = normalized.tools.length
      ? parseToolCallFromText(fullText, normalized.tools)
      : null;

    let output = [];
    if (toolCall) {
      output = [
        writeResponseToolCall(res, responseId, toolCall, {
          remember: (item) => toolCalls.remember(item),
        }),
      ];
      pushLog(`DeepSeek Web requested tool: ${toolCall.spec.name}`);
    } else if (fullText) {
      if (!textStarted) {
        writeResponseTextStart(res, responseId);
        textStarted = true;
        writeResponseTextDelta(res, responseId, fullText);
      }
      output = [writeResponseTextDone(res, responseId, fullText)];
    }

    writeResponseCompleted(res, responseId, model, output);
    sseDone(res);
    res.end();
  }

  async function jsonResponses(res, body, options = {}) {
    const normalized = normalizeResponsesRequest(body, {
      defaultModel: config.models[0],
      lookupSession: (id) => responseSessions.get(id),
      lookupToolCall: (id) => toolCalls.get(id),
      remember: (item) => toolCalls.remember(item),
    });

    const responseId = `resp_ds_${Date.now()}`;
    const model = normalized.model;
    const ctx = { requestId: responseId, created: Math.floor(Date.now() / 1000), model };
    responseSessions.set(responseId, normalized.sessionKey);

    let content = "";
    for await (const event of pipeline.runChatCompletion(normalized, ctx, options.signal)) {
      if (event.type === "text_delta" && event.delta) content += event.delta;
    }

    const toolCall = normalized.tools.length
      ? parseToolCallFromText(content, normalized.tools)
      : null;

    sendJson(
      res,
      200,
      responsesJson({
        responseId,
        model,
        content,
        toolCall,
        remember: (item) => toolCalls.remember(item),
      }),
    );
  }

  async function handleChatCompletions(req, res) {
    const body = await readJsonBody(req);
    if (body.stream !== false) {
      await streamChatCompletions(res, { ...body, stream: true });
      return;
    }
    const abort = createRequestAbort(res);
    try {
      await jsonChatCompletions(res, body, { signal: abort.signal });
    } finally {
      abort.dispose();
    }
  }

  async function handleResponses(req, res) {
    const body = await readJsonBody(req);
    if (body.stream !== false) {
      await streamResponses(res, body);
      return;
    }
    const abort = createRequestAbort(res);
    try {
      await jsonResponses(res, body, { signal: abort.signal });
    } finally {
      abort.dispose();
    }
  }

  async function handleChatTest(req, res) {
    const body = await readJsonBody(req);
    const message = String(body.message || "").trim();
    if (!message) {
      sendJson(res, 400, { ok: false, error: "请输入测试消息。" });
      return;
    }
    await streamChatCompletions(res, {
      model: body.model || config.models[0],
      stream: true,
      user: "ui-test",
      messages: [{ role: "user", content: message }],
    });
  }

  const handlers = {
    status: async (req, res) => {
      sendJson(res, 200, await statusPayload());
    },
    fingerprint: async (req, res) => {
      // Redacted view of exactly what the adapter will send upstream.
      sendJson(res, 200, await fingerprint.describe(authManager.peek()));
    },
    events: (req, res) => handleSse(req, res),
    login: (req, res) => startLogin(res),
    chatTest: (req, res) => handleChatTest(req, res),
    models: (req, res) => {
      sendJson(res, 200, modelPayload());
    },
    chatCompletions: (req, res) => handleChatCompletions(req, res),
    responses: (req, res) => handleResponses(req, res),
  };

  // Error mapping: bridge errors surface a stable code; client disconnects stay quiet.
  function handleError(error, res) {
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
  }

  return {
    config,
    state,
    authManager,
    pipeline,
    fingerprint,
    handlers,
    handleError,
    pushLog,
    get port() {
      return listenPort;
    },
    setPort(port) {
      listenPort = Number(port) || listenPort;
    },
  };
}

export async function startServer(port, options = {}) {
  const config = options.config || readConfig();
  const runtime = createRuntime(config);
  const listenPort = port === undefined ? config.port : Number(port);

  try {
    const credentials = await runtime.authManager.getCredentials();
    if (credentials) {
      runtime.pushLog("已找到本地保存的凭证。");
    } else {
      runtime.pushLog("还没有保存的凭证。");
    }
  } catch {
    runtime.pushLog("还没有保存的凭证。");
  }

  const corsPolicy = createCorsPolicy(config.cors.allowOrigins, {
    maxAgeSeconds: config.cors.maxAgeSeconds,
  });
  const handleRequest = createRouter({
    publicDir: PUBLIC_DIR,
    corsPolicy,
    handlers: runtime.handlers,
  });

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => runtime.handleError(error, res));
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(listenPort, config.host);
  });

  runtime.setPort(server.address().port);

  const shownHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  console.log(`DeepSeek 桥接器：http://${shownHost}:${server.address().port}`);
  return server;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
