import crypto from "node:crypto";
import { SHA3_WASM_B64 } from "./deepseek-pow-wasm.mjs";
import { ENDPOINTS, createHeaderLayer } from "./headers/upstream.mjs";
import {
  UpstreamError,
  UpstreamErrorKind,
  upstreamHttpError,
} from "./upstream-error.mjs";

const DEEPSEEK_BASE_URL = "https://chat.deepseek.com";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let wasmInstancePromise = null;

function normalizeModel(model = "") {
  const id = String(model || "deepseek-chat").replace(/^deepseek-web\//, "");
  if (id.includes("reasoner") || id.includes("r1")) return "deepseek-reasoner";
  return "deepseek-chat";
}

function hasMeaningfulText(value) {
  return typeof value === "string" && value.length > 0;
}

async function loadDeepSeekHashWasm() {
  if (wasmInstancePromise) return wasmInstancePromise;

  wasmInstancePromise = (async () => {
    const wasmBuffer = Buffer.from(SHA3_WASM_B64, "base64");
    const { instance } = await WebAssembly.instantiate(wasmBuffer, { wbg: {} });
    return instance;
  })();

  return wasmInstancePromise;
}

export class DeepSeekWebClient {
  constructor(options = {}) {
    this.cookie = options.cookie || "";
    this.bearer = options.bearer || "";
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    // Options come from the config layer; the header layer never re-reads process.env
    // when `env` is injected (see src/config.mjs).
    const headerOptions = {
      ...(options.headerOptions || {}),
      ...(options.capturePath ? { capturePath: options.capturePath } : {}),
      ...(options.devicePath ? { devicePath: options.devicePath } : {}),
    };
    // One header layer per client: it owns the fingerprint, device id and risk cache.
    this.headerLayer =
      options.headerLayer ||
      createHeaderLayer({
        ...headerOptions,
        cookie: this.cookie,
        bearer: this.bearer,
        userAgent: headerOptions.userAgent || this.userAgent,
        log: headerOptions.log || options.log,
      });
    this.userAgent = this.headerLayer.fingerprint.userAgent;
  }

  // Endpoint-aware headers; kept async so existing call sites stay unchanged.
  async fetchHeaders(endpoint = ENDPOINTS.settings, extra = {}) {
    return this.headerLayer.forEndpoint(endpoint, extra);
  }

  async refreshRiskHeaders() {
    return this.headerLayer.refreshRiskHeaders();
  }

  describeFingerprint() {
    return this.headerLayer.describe();
  }

  async init() {
    await this.refreshRiskHeaders();
    await fetch(`${DEEPSEEK_BASE_URL}/api/v0/client/settings?did=&scope=banner`, {
      headers: await this.fetchHeaders(ENDPOINTS.settings, { method: "GET" }),
    }).catch(() => null);
  }

  async createPowChallenge(targetPath, signal) {
    await this.refreshRiskHeaders();
    const res = await fetch(`${DEEPSEEK_BASE_URL}${ENDPOINTS.powChallenge}`, {
      method: "POST",
      headers: await this.fetchHeaders(ENDPOINTS.powChallenge),
      body: JSON.stringify({ target_path: targetPath }),
      signal,
    });

    if (!res.ok) {
      throw upstreamHttpError("创建 DeepSeek PoW 失败", res, await res.text());
    }

    const data = await res.json();
    const challenge = data.data?.biz_data?.challenge || data.data?.challenge || data.challenge;
    if (!challenge) {
      throw new UpstreamError("DeepSeek PoW 返回里没有 challenge", {
        kind: UpstreamErrorKind.PROTOCOL,
        retryable: true,
      });
    }
    return challenge;
  }

  async solvePow(challenge) {
    const { algorithm, challenge: target, salt, difficulty, expire_at: expireAt } = challenge;

    if (algorithm === "sha256") {
      let nonce = 0;
      while (nonce <= 1_000_000) {
        const input = `${salt}${target}${nonce}`;
        const hash = crypto.createHash("sha256").update(input).digest("hex");
        let zeroBits = 0;
        for (const char of hash) {
          const value = Number.parseInt(char, 16);
          if (value === 0) {
            zeroBits += 4;
          } else {
            zeroBits += Math.clz32(value) - 28;
            break;
          }
        }
        const targetDifficulty = difficulty > 1000 ? Math.floor(Math.log2(difficulty)) : difficulty;
        if (zeroBits >= targetDifficulty) {
          return nonce;
        }
        nonce++;
      }
      throw new UpstreamError("DeepSeek sha256 PoW 计算超时", {
        kind: UpstreamErrorKind.TIMEOUT,
        retryable: true,
      });
    }

    if (algorithm === "DeepSeekHashV1") {
      const instance = await loadDeepSeekHashWasm();
      const exports = instance.exports;
      const memory = exports.memory;
      const alloc = exports.__wbindgen_export_0;
      const addToStack = exports.__wbindgen_add_to_stack_pointer;
      const wasmSolve = exports.wasm_solve;

      const encodeString = (value) => {
        const buffer = Buffer.from(value, "utf8");
        const ptr = alloc(buffer.length, 1);
        new Uint8Array(memory.buffer).set(buffer, ptr);
        return [ptr, buffer.length];
      };

      const [ptrC, lenC] = encodeString(target);
      const [ptrP, lenP] = encodeString(`${salt}_${expireAt}_`);
      const retptr = addToStack(-16);
      wasmSolve(retptr, ptrC, lenC, ptrP, lenP, difficulty);

      const view = new DataView(memory.buffer);
      const status = view.getInt32(retptr, true);
      const answer = view.getFloat64(retptr + 8, true);
      addToStack(16);

      if (status === 0) {
        throw new UpstreamError("DeepSeekHashV1 PoW 没有找到答案", {
          kind: UpstreamErrorKind.PROTOCOL,
          retryable: false,
        });
      }
      return answer;
    }

    throw new UpstreamError(`不支持的 DeepSeek PoW 算法：${algorithm}`, {
      kind: UpstreamErrorKind.PROTOCOL,
      retryable: false,
    });
  }

  async createChatSession(signal) {
    const targetPath = ENDPOINTS.createSession;
    await this.refreshRiskHeaders();
    const res = await fetch(`${DEEPSEEK_BASE_URL}${targetPath}`, {
      method: "POST",
      headers: await this.fetchHeaders(targetPath),
      body: JSON.stringify({}),
      signal,
    });

    if (!res.ok) {
      throw upstreamHttpError("创建 DeepSeek 会话失败", res, await res.text());
    }

    const data = await res.json();
    const session = data.data?.biz_data?.chat_session || data.data?.biz_data || {};
    const sessionId = session.id || session.chat_session_id || "";
    if (!sessionId) {
      throw new UpstreamError("DeepSeek 会话返回里没有 session id", {
        kind: UpstreamErrorKind.PROTOCOL,
        retryable: true,
      });
    }
    return {
      ...session,
      chat_session_id: sessionId,
    };
  }

  async chatCompletions(params) {
    const targetPath = ENDPOINTS.completion;
    const challenge = await this.createPowChallenge(targetPath, params.signal);
    const answer = await this.solvePow(challenge);
    const powResponse = Buffer.from(
      JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer,
        ...(challenge.signature ? { signature: challenge.signature } : {}),
        target_path: targetPath,
      }),
    ).toString("base64");

    await this.refreshRiskHeaders();
    const model = normalizeModel(params.model);
    const res = await fetch(`${DEEPSEEK_BASE_URL}${targetPath}`, {
      method: "POST",
      headers: await this.fetchHeaders(targetPath, { powResponse }),
      body: JSON.stringify({
        chat_session_id: params.sessionId,
        parent_message_id: params.parentMessageId ?? null,
        model_type: null,
        prompt: params.message,
        ref_file_ids: params.fileIds || [],
        thinking_enabled: model !== "deepseek-chat",
        search_enabled: params.searchEnabled ?? false,
        action: null,
        preempt: params.preempt ?? false,
      }),
      signal: params.signal,
    });

    if (!res.ok) {
      throw upstreamHttpError("DeepSeek 对话请求失败", res, await res.text());
    }
    if (!res.body) {
      throw new UpstreamError("DeepSeek 对话没有返回流", {
        kind: UpstreamErrorKind.PROTOCOL,
        retryable: true,
      });
    }
    return res.body;
  }
}

// Header inspection for observability. Exposed by the adapter so orchestration/server
// never import the header layer directly.
export function describeFingerprintHeaders(options = {}) {
  const headerOptions = options.headerOptions || {};
  const layer = createHeaderLayer({
    ...headerOptions,
    cookie: options.cookie,
    bearer: options.bearer,
    userAgent: options.userAgent || headerOptions.userAgent,
    log: headerOptions.log || options.log,
  });
  return layer.describe();
}

function isReasoningFragmentType(type) {
  const normalized = String(type || "").toUpperCase();
  return normalized === "THINK" || normalized === "THINKING" || normalized === "REASONING";
}

export function deepSeekEventsFromSseData(data, state = {}) {
  const events = [];

  if (data.response_message_id !== undefined && data.response_message_id !== null) {
    events.push({ type: "meta", parentMessageId: data.response_message_id });
  }

  const path = hasMeaningfulText(data.p) ? data.p : state.lastPath || "";
  if (hasMeaningfulText(data.p)) {
    state.lastPath = data.p;
  }

  const pushText = (delta) => {
    if (hasMeaningfulText(delta)) events.push({ type: "text", delta });
  };
  const pushReasoning = (delta) => {
    if (hasMeaningfulText(delta)) events.push({ type: "reasoning", delta });
  };
  const pushFragmentText = (value) => {
    if (!hasMeaningfulText(value)) return;
    if (state.thought) pushReasoning(value);
    else pushText(value);
  };

  const fragments = Array.isArray(data.v)
    ? data.v
    : Array.isArray(data.v?.response?.fragments)
      ? data.v.response.fragments
      : null;

  if (fragments) {
    for (const fragment of fragments) {
      if (!fragment || typeof fragment !== "object") continue;
      if (isReasoningFragmentType(fragment.type)) {
        state.thought = true;
        pushReasoning(fragment.content || "");
        continue;
      }
      if (typeof fragment.content === "string" && fragment.content) {
        state.thought = false;
        pushText(fragment.content);
        continue;
      }
      if (typeof fragment.v === "string" && fragment.v && hasMeaningfulText(fragment.p)) {
        if (isReasoningFragmentType(fragment.type) || /reasoning|thinking/i.test(fragment.p)) {
          state.thought = true;
          pushReasoning(fragment.v);
        } else if (/content|choices/i.test(fragment.p)) {
          pushFragmentText(fragment.v);
        }
      }
    }
    return events;
  }

  if (typeof data.v === "string" && data.v) {
    if (data.type === "thinking" || data.type === "reasoning") {
      state.thought = true;
      pushReasoning(data.v);
    } else if (/reasoning|thinking/i.test(path)) {
      state.thought = true;
      pushReasoning(data.v);
    } else if (/content|choices/i.test(path)) {
      pushFragmentText(data.v);
    } else if (!path) {
      pushText(data.v);
    }
    return events;
  }

  if ((data.type === "thinking" || data.type === "reasoning") && hasMeaningfulText(data.content)) {
    state.thought = true;
    pushReasoning(data.content);
    return events;
  }
  if (data.type === "text" && hasMeaningfulText(data.content)) {
    state.thought = false;
    pushText(data.content);
    return events;
  }

  const choice = data.choices?.[0];
  if (choice?.delta?.reasoning_content) pushReasoning(choice.delta.reasoning_content);
  if (choice?.delta?.content) pushText(choice.delta.content);

  return events;
}

export async function* parseDeepSeekStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const state = {};
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      // SSE allows both "data: {...}" and "data:{...}".
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const data = JSON.parse(payload);
        for (const event of deepSeekEventsFromSseData(data, state)) {
          yield event;
        }
      } catch {
        // Ignore partial or non-JSON SSE payloads.
      }
    }
  }

  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    const payload = tail.slice(5).trim();
    if (payload && payload !== "[DONE]") {
      try {
        const data = JSON.parse(payload);
        for (const event of deepSeekEventsFromSseData(data, state)) {
          yield event;
        }
      } catch {
        // Ignore partial or non-JSON SSE payloads.
      }
    }
  }
}
