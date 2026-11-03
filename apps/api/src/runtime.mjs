// Runtime composition: wire config, orchestration services, and HTTP handlers.
import { createAuthManager } from "@deepseek-web-opencode/core/orchestration/auth-manager";
import { createFingerprintService } from "@deepseek-web-opencode/core/orchestration/fingerprint-service";
import { createPipeline } from "@deepseek-web-opencode/core/orchestration/pipeline";
import { createProviderClient } from "@deepseek-web-opencode/core/orchestration/provider-client";
import { createSessionStore } from "@deepseek-web-opencode/core/orchestration/session-store";
import { createToolCallRegistry } from "@deepseek-web-opencode/core/orchestration/tool-call-registry";
import {
  readCredentials,
  runDeepSeekLogin,
  summarizeCredentials,
} from "@deepseek-web-opencode/deepseek-web/auth";
import { readConfig } from "./config.mjs";
import { createChatCompletionHandlers } from "./handlers/chat-completions.mjs";
import { createErrorHandler } from "./handlers/errors.mjs";
import { createResponsesHandlers } from "./handlers/responses.mjs";
import { createSystemHandlers } from "./handlers/system.mjs";
import { createToolTraceStore } from "./tool-trace-store.mjs";

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
  const toolTrace = deps.toolTrace || createToolTraceStore(config.toolTrace || { enabled: false });

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

  async function recordToolTrace(entry) {
    const storedPath = await toolTrace.record(entry);
    if (toolTrace.enabled && !storedPath) {
      pushLog(`DSML trace persistence failed for request=${entry.requestId || "unknown"}`, "error");
    }
    return storedPath;
  }

  // Dependencies are injected at the composition root; production passes none.
  const authManager =
    deps.authManager ||
    createAuthManager({
      loadCredentials: () => readCredentials(config.auth.path),
      createClient: (credentials) =>
        createProviderClient(credentials, {
          headerOptions: config.header,
          log: pushLog,
        }),
      runLogin: (options = {}) =>
        runDeepSeekLogin({
          authPath: config.auth.path,
          profileDir: config.auth.profileDir,
          port: config.auth.cdpPort,
          timeoutMs: config.auth.loginTimeoutMs,
          browser: config.auth.browser,
          ...options,
        }),
      summarize: (credentials) => summarizeCredentials(credentials, config.auth.path),
      authPath: config.auth.path,
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

  const handlers = {
    ...createSystemHandlers({
      config,
      state,
      authManager,
      fingerprint,
      pushLog,
      getPort: () => listenPort,
    }),
    ...createChatCompletionHandlers({
      config,
      pipeline,
      pushLog,
      recordToolTrace,
    }),
    ...createResponsesHandlers({
      config,
      pipeline,
      responseSessions,
      toolCalls,
      pushLog,
      recordToolTrace,
    }),
  };
  const handleError = createErrorHandler({ state, pushLog });

  return {
    config,
    state,
    authManager,
    pipeline,
    fingerprint,
    toolTrace,
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
