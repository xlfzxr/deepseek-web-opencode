// Responses handlers: adapt normalized completions to Responses JSON/SSE events.
import { normalizeResponsesRequest } from "@deepseek-web-opencode/core/orchestration/request-normalizer";
import { parseToolCallsFromText } from "@deepseek-web-opencode/core/orchestration/tool-parser";
import { runToolLoop } from "@deepseek-web-opencode/core/orchestration/tool-loop";
import { createRequestAbort, readJsonBody, sendJson } from "@deepseek-web-opencode/transport/http";
import { responsesJson } from "@deepseek-web-opencode/transport/openai-json";
import {
  writeResponseCompleted,
  writeResponseStart,
  writeResponseTextDelta,
  writeResponseTextDone,
  writeResponseTextStart,
  writeResponseToolCall,
} from "@deepseek-web-opencode/transport/openai-sse";
import { openSse, sseDone } from "@deepseek-web-opencode/transport/sse-writer";

export function createResponsesHandlers({
  config,
  pipeline,
  responseSessions,
  toolCalls,
  pushLog,
  recordToolTrace = async () => {},
}) {
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
    const toolCallItems = [];

    const upstream = normalized.tools.length
      ? runToolLoop({
          pipeline,
          normalized,
          tools: normalized.tools,
          ctx,
          signal,
          parseToolCall: parseToolCallsFromText,
          log: pushLog,
          recordTrace: recordToolTrace,
          streamText: true,
        })
      : pipeline.runChatCompletion(normalized, ctx, signal);

    for await (const event of upstream) {
      if (event.type === "tool_call_done") {
        toolCallItems.push(event.payload);
        continue;
      }
      if (event.type !== "text_delta" && event.type !== "reasoning_delta") continue;
      const delta = event.delta ?? "";
      if (!delta) continue;
      if (normalized.tools.length) {
        if (event.type === "text_delta") {
          if (!textStarted) {
            writeResponseTextStart(res, responseId);
            textStarted = true;
          }
          fullText += delta;
          writeResponseTextDelta(res, responseId, delta);
        }
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

    let output = [];
    if (toolCallItems.length) {
      if (fullText) output.push(writeResponseTextDone(res, responseId, fullText));
      for (const toolCall of toolCallItems) {
        const outputIndex = output.length;
        pushLog(`DeepSeek Web requested tool: ${toolCall.spec.name}`);
        output.push(
          writeResponseToolCall(res, responseId, toolCall, {
            outputIndex,
            remember: (item) => toolCalls.remember(item),
          }),
        );
      }
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
    const parsedToolCalls = [];
    if (normalized.tools.length) {
      for await (const event of runToolLoop({
        pipeline,
        normalized,
        tools: normalized.tools,
        ctx,
        signal: options.signal,
        parseToolCall: parseToolCallsFromText,
        log: pushLog,
        recordTrace: recordToolTrace,
      })) {
        if (event.type === "text_delta" && event.delta) content += event.delta;
        if (event.type === "tool_call_done") parsedToolCalls.push(event.payload);
      }
    } else {
      for await (const event of pipeline.runChatCompletion(normalized, ctx, options.signal)) {
        if (event.type === "text_delta" && event.delta) content += event.delta;
      }
    }

    sendJson(
      res,
      200,
      responsesJson({
        responseId,
        model,
        content,
        toolCalls: parsedToolCalls,
        remember: (item) => toolCalls.remember(item),
      }),
    );
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

  return {
    responses: (req, res) => handleResponses(req, res),
  };
}
