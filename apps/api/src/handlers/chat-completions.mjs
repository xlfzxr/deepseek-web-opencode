// Chat Completions handlers: normalize input and serialize chat JSON/SSE responses.
import { normalizeChatRequest } from "@deepseek-web-opencode/core/orchestration/request-normalizer";
import { parseToolCallFromText } from "@deepseek-web-opencode/core/orchestration/tool-parser";
import { runToolLoop } from "@deepseek-web-opencode/core/orchestration/tool-loop";
import { createRequestAbort, readJsonBody, sendJson } from "@deepseek-web-opencode/transport/http";
import { chatCompletionJson } from "@deepseek-web-opencode/transport/openai-json";
import { writeChatChunk, writeChatFinish, writeChatToolCall } from "@deepseek-web-opencode/transport/openai-sse";
import { openSse, sseDone } from "@deepseek-web-opencode/transport/sse-writer";

export function createChatCompletionHandlers({ config, pipeline, pushLog }) {
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

  return {
    chatCompletions: (req, res) => handleChatCompletions(req, res),
    chatTest: (req, res) => handleChatTest(req, res),
  };
}
