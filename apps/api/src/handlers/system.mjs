// System handlers: status, fingerprint, login, model list, and UI event stream.
import { sendJson } from "@deepseek-web-opencode/transport/http";
import { openSse } from "@deepseek-web-opencode/transport/sse-writer";

export function createSystemHandlers({ config, state, authManager, fingerprint, pushLog, getPort }) {
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
        baseUrl: `http://127.0.0.1:${getPort()}/v1`,
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
  async function handleEvents(req, res) {
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

  return {
    status: async (req, res) => {
      sendJson(res, 200, await statusPayload());
    },
    fingerprint: async (req, res) => {
      // Redacted view of exactly what the adapter will send upstream.
      sendJson(res, 200, await fingerprint.describe(authManager.peek()));
    },
    events: (req, res) => handleEvents(req, res),
    login: (req, res) => startLogin(res),
    models: (req, res) => {
      sendJson(res, 200, modelPayload());
    },
  };
}
