import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTH_PATH,
  DEFAULT_PORT as DEFAULT_CDP_PORT,
  readCredentials,
  runDeepSeekLogin,
  summarizeCredentials,
} from "./deepseek-auth.mjs";
import { DeepSeekWebClient } from "./deepseek-web-client.mjs";
import { parseToolCallFromText } from "./dsml.mjs";
import {
  buildToolPrompt,
  chatCompletionsToPrompt,
  extractChatTools,
  extractResponseTools,
  makeResponseBase,
  makeResponseMessageItem,
  makeToolCallItem,
  responseContentPartToText,
  stringifyForPrompt,
} from "./openai-shape.mjs";
import { createAuthManager } from "./orchestration/auth-manager.mjs";
import { createPipeline } from "./orchestration/pipeline.mjs";
import { runToolLoop } from "./orchestration/tool-loop.mjs";
import { createSessionStore } from "./orchestration/session-store.mjs";
import { createHeaderLayer } from "./headers/upstream.mjs";
import { createCorsPolicy } from "./transport/cors.mjs";
import { createRequestAbort, sendJson, readJsonBody } from "./transport/http.mjs";
import { createRouter } from "./transport/router.mjs";
import { openSse, sseWrite, sseEvent, sseDone } from "./transport/sse-writer.mjs";

export { parseToolCallFromText };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DEFAULT_UI_PORT = 8787;
const CHAT_MODEL = "deepseek-web/deepseek-chat";
const REASONER_MODEL = "deepseek-web/deepseek-reasoner";
const DEFAULT_API_KEY_HINT = "deepseek";

const state = {
  running: false,
  lastError: "",
  logs: [],
  clients: new Set(),
  toolCalls: new Map(),
};

const chatSessions = createSessionStore();
const responseSessions = createSessionStore();
const authManager = createAuthManager({
  loadCredentials: readCredentials,
  createClient: async (credentials) => {
    const client = new DeepSeekWebClient(credentials);
    await client.init();
    return client;
  },
});

const pipeline = createPipeline({
  authManager,
  sessionStore: chatSessions,
  log: pushLog,
  defaultModel: CHAT_MODEL,
});

function nowStamp() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

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


async function describeHeaders() {
  const client = authManager.peek();
  if (client?.describeFingerprint) return client.describeFingerprint();
  const credentials = await readCredentials();
  return createHeaderLayer({
    userAgent: credentials?.userAgent,
    cookie: credentials?.cookie,
    bearer: credentials?.bearer,
    env: process.env,
    log: pushLog,
  }).describe();
}

async function statusPayload() {
  const credentials = await readCredentials();
  const headers = await describeHeaders();
  return {
    running: state.running,
    lastError: state.lastError,
    authPath: AUTH_PATH,
    gateway: {
      baseUrl: `http://127.0.0.1:${Number(process.env.PORT || DEFAULT_UI_PORT)}/v1`,
      apiKey: DEFAULT_API_KEY_HINT,
      responsesEndpoint: "/v1/responses",
      chatEndpoint: "/v1/chat/completions",
      models: [CHAT_MODEL, REASONER_MODEL],
      toolCalling: {
        enabled: true,
        strategy: "prompt-xml-to-responses-events",
        events: [
          "response.function_call_arguments.done",
          "response.custom_tool_call_input.done",
        ],
      },
    },
    credentials: summarizeCredentials(credentials),
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

  void runDeepSeekLogin({
    port: DEFAULT_CDP_PORT,
    onProgress: (message) => pushLog(message),
  })
    .then(() => {
      authManager.invalidate();
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
  const stream = openSse(res, { retryMs: 3000, initialComment: "connected" });
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

async function makeDeepSeekClient() {
  return authManager.getClient();
}

function modelPayload() {
  return {
    object: "list",
    data: [
      {
        id: CHAT_MODEL,
        object: "model",
        created: 0,
        owned_by: "deepseek-web",
      },
      {
        id: REASONER_MODEL,
        object: "model",
        created: 0,
        owned_by: "deepseek-web",
      },
    ],
  };
}


function rememberToolCall(item) {
  if (!item?.call_id) return;
  state.toolCalls.set(item.call_id, {
    name: item.name || "tool",
    type: item.type || "function_call",
  });

  if (state.toolCalls.size > 500) {
    const firstKey = state.toolCalls.keys().next().value;
    if (firstKey) state.toolCalls.delete(firstKey);
  }
}

function responseInputItemToText(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";

  const type = item.type || "message";
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const output = responseContentPartToText(item.output) || responseContentPartToText(item.content);
    const callId = item.call_id || item.id || "";
    const cached = callId ? state.toolCalls.get(callId) : null;
    const toolName = item.name || cached?.name || "tool";
    return output ? `tool result from ${toolName}${callId ? ` (${callId})` : ""}: ${output}` : "";
  }

  if (type === "function_call" || type === "custom_tool_call" || type === "tool_search_call") {
    rememberToolCall(item);
    const toolName = item.name || "tool";
    const callId = item.call_id || item.id || "";
    const args =
      type === "custom_tool_call"
        ? responseContentPartToText(item.input)
        : responseContentPartToText(item.arguments) || stringifyForPrompt(item.arguments, 4000);
    return `assistant requested ${toolName}${callId ? ` (${callId})` : ""}: ${args}`;
  }

  if (type !== "message" && type !== "input_text" && type !== "output_text") {
    return "";
  }

  const role = item.role || "user";
  const content = Array.isArray(item.content)
    ? item.content.map(responseContentPartToText).filter(Boolean).join("\n")
    : responseContentPartToText(item.content || item.text || item);

  return content.trim() ? `${role}: ${content.trim()}` : "";
}

function responsesToPrompt(body, tools = extractResponseTools(body)) {
  const parts = [];
  const instructions = responseContentPartToText(body.instructions);
  if (instructions.trim()) {
    parts.push(`system: ${instructions.trim()}`);
  }

  const toolPrompt = buildToolPrompt(tools);
  if (toolPrompt) {
    parts.push(toolPrompt);
  }

  if (typeof body.input === "string") {
    parts.push(`user: ${body.input.trim()}`);
  } else if (Array.isArray(body.input)) {
    parts.push(...body.input.map(responseInputItemToText).filter(Boolean));
  } else if (body.input && typeof body.input === "object") {
    const text = responseInputItemToText(body.input);
    if (text) parts.push(text);
  }

  return parts.join("\n\n");
}


function responsesSessionKeyFromBody(body) {
  const previous = body.previous_response_id;
  if (previous && responseSessions.get(previous)) {
    return responseSessions.get(previous);
  }
  return body.metadata?.session_id || body.session_id || body.user || "responses-default";
}

function rememberResponseSession(responseId, sessionKey) {
  responseSessions.set(responseId, sessionKey);
}

function sessionKeyFromBody(body) {
  return body.user || body.metadata?.session_id || body.session_id || "default";
}




function makeChatToolCall(toolCall) {
  const callId = toolCall.id || `call_ds_${Date.now()}`;
  const payload = toolCall.arguments || "{}";
  const item = {
    id: callId,
    type: "function",
    function: {
      name: toolCall.spec.name,
      arguments: payload,
    },
  };
  rememberToolCall({
    call_id: callId,
    name: toolCall.spec.name,
    type: "function_call",
  });
  return item;
}

function makeChatToolCallDelta(toolCall) {
  const callId = toolCall.id || `call_ds_${Date.now()}`;
  const payload = toolCall.arguments || "{}";
  rememberToolCall({
    call_id: callId,
    name: toolCall.spec.name,
    type: "function_call",
  });
  return [
    {
      index: 0,
      id: callId,
      type: "function",
      function: {
        name: toolCall.spec.name,
        arguments: payload,
      },
    },
  ];
}

function writeResponseToolCall(res, responseId, toolCall) {
  const itemIdPrefix = toolCall.spec.kind === "custom" ? "ctc" : "fc";
  const itemId = `${responseId}_${itemIdPrefix}`;
  const callId = toolCall.id || `call_ds_${Date.now()}`;
  const payload = toolCall.arguments || (toolCall.spec.kind === "custom" ? "" : "{}");
  const inProgressItem = makeToolCallItem(itemId, "in_progress", callId, toolCall, "");
  const completedItem = makeToolCallItem(itemId, "completed", callId, toolCall, payload);

  sseEvent(res, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: inProgressItem,
  });

  if (toolCall.spec.kind === "custom") {
    if (payload) {
      sseEvent(res, "response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta",
        item_id: itemId,
        output_index: 0,
        delta: payload,
      });
    }
    sseEvent(res, "response.custom_tool_call_input.done", {
      type: "response.custom_tool_call_input.done",
      item_id: itemId,
      output_index: 0,
      input: payload,
    });
  } else if (toolCall.spec.kind !== "tool_search") {
    if (payload) {
      sseEvent(res, "response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: itemId,
        output_index: 0,
        delta: payload,
      });
    }
    sseEvent(res, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: 0,
      arguments: payload,
    });
  }

  sseEvent(res, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item: completedItem,
  });
  rememberToolCall(completedItem);
  return completedItem;
}

function writeResponseStart(res, responseId, model) {
  sseEvent(res, "response.created", {
    type: "response.created",
    response: makeResponseBase(responseId, model, "in_progress", []),
  });
  sseEvent(res, "response.in_progress", {
    type: "response.in_progress",
    response: makeResponseBase(responseId, model, "in_progress", []),
  });
}

function writeResponseTextStart(res, responseId) {
  const itemId = `${responseId}_msg`;
  sseEvent(res, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: makeResponseMessageItem(itemId, "in_progress"),
  });
  sseEvent(res, "response.content_part.added", {
    type: "response.content_part.added",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: {
      type: "output_text",
      text: "",
      annotations: [],
    },
  });
  return itemId;
}

function writeResponseTextDone(res, responseId, text) {
  const itemId = `${responseId}_msg`;
  const item = makeResponseMessageItem(itemId, "completed", text);
  sseEvent(res, "response.output_text.done", {
    type: "response.output_text.done",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text,
  });
  sseEvent(res, "response.content_part.done", {
    type: "response.content_part.done",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: {
      type: "output_text",
      text,
      annotations: [],
    },
  });
  sseEvent(res, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item,
  });
  return item;
}

function writeResponseCompleted(res, responseId, model, output) {
  sseEvent(res, "response.completed", {
    type: "response.completed",
    response: makeResponseBase(responseId, model, "completed", output),
  });
}

async function streamChatCompletions(res, body, options = {}) {
  const tools = extractChatTools(body);
  const stream = openSse(res);
  const signal = options.signal || stream.signal;

  const requestId = `chatcmpl-ds-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || CHAT_MODEL;
  const normalized = {
    sessionKey: sessionKeyFromBody(body),
    model,
    prompt: body.prompt || chatCompletionsToPrompt(body),
    searchEnabled: Boolean(body.search_enabled),
  };

  let fullText = "";
  if (tools.length) {
    for await (const event of runToolLoop({
      pipeline,
      normalized,
      tools,
      ctx: { requestId, created, model },
      signal,
      parseToolCall: parseToolCallFromText,
    })) {
      if (event.type === "text_delta" && event.delta) fullText += event.delta;
      if (event.type !== "tool_call_done") continue;
      const toolCall = { id: event.payload.id, spec: event.payload.spec, arguments: event.payload.arguments };
      sseWrite(res, {
        id: requestId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: makeChatToolCallDelta(toolCall),
            },
            finish_reason: null,
          },
        ],
      });
      sseWrite(res, {
        id: requestId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      });
      pushLog(`DeepSeek Web requested chat tool: ${event.payload.name}`);
      sseDone(res);
      res.end();
      return;
    }
    if (fullText) {
      sseWrite(res, {
        id: requestId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { content: fullText },
            finish_reason: null,
          },
        ],
      });
    }
  } else {
    for await (const event of pipeline.runChatCompletion(normalized, { requestId, created, model }, signal)) {
      const delta = event.delta ?? "";
      if (!delta || (event.type !== "text_delta" && event.type !== "reasoning_delta")) continue;
      sseWrite(res, {
        id: requestId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta:
              event.type === "reasoning_delta"
                ? { reasoning_content: delta }
                : { content: delta },
            finish_reason: null,
          },
        ],
      });
    }
  }

  sseWrite(res, {
    id: requestId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  sseDone(res);
  res.end();
}

async function jsonChatCompletions(res, body, signal) {
  const tools = extractChatTools(body);
  const requestId = `chatcmpl-ds-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || CHAT_MODEL;
  const normalized = {
    sessionKey: sessionKeyFromBody(body),
    model,
    prompt: body.prompt || chatCompletionsToPrompt(body),
    searchEnabled: Boolean(body.search_enabled),
  };

  let content = "";
  for await (const event of pipeline.runChatCompletion(normalized, { requestId, created, model }, signal)) {
    if (event.type === "text_delta" && event.delta) content += event.delta;
  }

  const toolCall = tools.length ? parseToolCallFromText(content, tools) : null;
  if (toolCall) {
    sendJson(res, 200, {
      id: requestId,
      object: "chat.completion",
      created: created,
      model: model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [makeChatToolCall(toolCall)],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
    pushLog(`DeepSeek Web requested chat tool: ${toolCall.spec.name}`);
    return;
  }

  sendJson(res, 200, {
    id: requestId,
    object: "chat.completion",
    created: created,
    model: model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });
}

async function streamResponses(res, body, options = {}) {
  const model = body.model || CHAT_MODEL;
  const responseId = `resp_ds_${Date.now()}`;
  const tools = extractResponseTools(body);
  const prompt = responsesToPrompt(body, tools);
  const sessionKey = responsesSessionKeyFromBody(body);
  rememberResponseSession(responseId, sessionKey);

  const stream = openSse(res);
  const signal = options.signal || stream.signal;

  writeResponseStart(res, responseId, model);
  let textStarted = false;
  let fullText = "";

  const normalized = {
    sessionKey,
    model,
    prompt,
    searchEnabled: Boolean(body.search_enabled),
  };
  const upstream = tools.length
    ? runToolLoop({
        pipeline,
        normalized,
        tools,
        ctx: { requestId: responseId, created: Math.floor(Date.now() / 1000), model },
        signal,
        parseToolCall: parseToolCallFromText,
      })
    : pipeline.runChatCompletion(normalized, { requestId: responseId, created: Math.floor(Date.now() / 1000), model }, signal);

  for await (const event of upstream) {
    if (event.type !== "text_delta" && event.type !== "reasoning_delta") continue;
    const delta = event.delta ?? "";
    if (!delta) continue;
    if (tools.length) {
      if (event.type === "text_delta") fullText += delta;
      continue;
    }
    if (event.type === "reasoning_delta") continue;
    if (!textStarted) {
      writeResponseTextStart(res, responseId);
      textStarted = true;
    }
    fullText += delta;
    sseEvent(res, "response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: `${responseId}_msg`,
      output_index: 0,
      content_index: 0,
      delta,
    });
  }

  const toolCall = tools.length ? parseToolCallFromText(fullText, tools) : null;
  let output = [];
  if (toolCall) {
    output = [writeResponseToolCall(res, responseId, toolCall)];
    pushLog(`DeepSeek Web requested tool: ${toolCall.spec.name}`);
  } else if (fullText) {
    if (!textStarted) {
      writeResponseTextStart(res, responseId);
      textStarted = true;
      sseEvent(res, "response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: `${responseId}_msg`,
        output_index: 0,
        content_index: 0,
        delta: fullText,
      });
    }
    output = [writeResponseTextDone(res, responseId, fullText)];
  }
  writeResponseCompleted(res, responseId, model, output);
  sseDone(res);
  res.end();
}

async function jsonResponses(res, body, signal) {
  const model = body.model || CHAT_MODEL;
  const responseId = `resp_ds_${Date.now()}`;
  const tools = extractResponseTools(body);
  const sessionKey = responsesSessionKeyFromBody(body);
  rememberResponseSession(responseId, sessionKey);
  const result = await (async () => {
    let content = "";
    for await (const event of pipeline.runChatCompletion(
      {
        sessionKey,
        model,
        prompt: responsesToPrompt(body, tools),
        searchEnabled: Boolean(body.search_enabled),
      },
      { requestId: responseId, created: Math.floor(Date.now() / 1000), model },
      signal,
    )) {
      if (event.type === "text_delta" && event.delta) content += event.delta;
    }
    return { content };
  })();

  const toolCall = tools.length ? parseToolCallFromText(result.content, tools) : null;
  if (toolCall) {
    const itemId = `${responseId}_${toolCall.spec.kind === "custom" ? "ctc" : "fc"}`;
    const callId = toolCall.id || `call_ds_${Date.now()}`;
    const item = makeToolCallItem(
      itemId,
      "completed",
      callId,
      toolCall,
      toolCall.arguments || (toolCall.spec.kind === "custom" ? "" : "{}"),
    );
    rememberToolCall(item);
    sendJson(res, 200, makeResponseBase(responseId, model, "completed", [item]));
    return;
  }

  sendJson(res, 200, makeResponseBase(responseId, model, "completed", [
    makeResponseMessageItem(`${responseId}_msg`, "completed", result.content),
  ]));
}

async function handleChatCompletions(req, res) {
  const body = await readJsonBody(req);
  if (body.stream !== false) {
    await streamChatCompletions(res, { ...body, stream: true });
    return;
  }
  const abort = createRequestAbort(res);
  try {
    await jsonChatCompletions(res, body, abort.signal);
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
    await jsonResponses(res, body, abort.signal);
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
    model: body.model || CHAT_MODEL,
    stream: true,
    user: "ui-test",
    messages: [{ role: "user", content: message }],
  });
}


const corsPolicy = createCorsPolicy(process.env.DEEPSEEK_BRIDGE_ALLOW_ORIGINS);

const handleRequest = createRouter({
  publicDir: PUBLIC_DIR,
  corsPolicy,
  handlers: {
    status: async (req, res) => {
      sendJson(res, 200, await statusPayload());
    },
    fingerprint: async (req, res) => {
      // Redacted view of exactly what the adapter will send upstream.
      sendJson(res, 200, await describeHeaders());
    },
    events: (req, res) => handleSse(req, res),
    login: (req, res) => startLogin(res),
    chatTest: (req, res) => handleChatTest(req, res),
    models: (req, res) => {
      sendJson(res, 200, modelPayload());
    },
    chatCompletions: (req, res) => handleChatCompletions(req, res),
    responses: (req, res) => handleResponses(req, res),
  },
});

export async function startServer(port = Number(process.env.PORT || DEFAULT_UI_PORT)) {
  try {
    const creds = await readFile(AUTH_PATH, "utf8");
    if (creds) {
      pushLog("已找到本地保存的凭证。");
    }
  } catch {
    pushLog("还没有保存的凭证。");
  }

  const host = process.env.DEEPSEEK_BRIDGE_HOST || "127.0.0.1";

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      const message = error?.message || String(error);
      const aborted = error?.name === "AbortError" || /abort|cancel/i.test(message);

      // Client hung up (opencode cancels streams): cancel upstream, stay quiet.
      if (aborted) {
        if (!res.destroyed && !res.writableEnded) {
          pushLog("客户端已断开，上游请求已取消。");
        }
        return;
      }

      state.lastError = message;
      pushLog(message, "error");

      if (res.destroyed || res.writableEnded) return;

      if (!res.headersSent) {
        sendJson(res, 500, { error: message });
      } else {
        sseWrite(res, { error: { message } });
        sseDone(res);
        res.end();
      }
    });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const shownHost = host === "0.0.0.0" ? "127.0.0.1" : host;
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
