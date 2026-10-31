// OpenAI-compatible SSE frame serialization (chat.completion.chunk + response.* events).
//
// Transport owns writing bytes. It receives already-normalized tool calls from
// orchestration and never talks to the DeepSeek adapter.

import {
  makeResponseBase,
  makeResponseMessageItem,
  makeToolCallItem,
} from "../openai-shape.mjs";
import { sseEvent, sseWrite } from "./sse-writer.mjs";

export function writeChatChunk(res, { requestId, created, model, delta, finishReason = null }) {
  return sseWrite(res, {
    id: requestId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

export function makeChatToolCall(toolCall) {
  const callId = toolCall.id || `call_ds_${Date.now()}`;
  return {
    id: callId,
    type: "function",
    function: {
      name: toolCall.spec.name,
      arguments: toolCall.arguments || "{}",
    },
  };
}

export function makeChatToolCallDelta(toolCall) {
  const callId = toolCall.id || `call_ds_${Date.now()}`;
  return [
    {
      index: 0,
      id: callId,
      type: "function",
      function: {
        name: toolCall.spec.name,
        arguments: toolCall.arguments || "{}",
      },
    },
  ];
}

export function writeChatToolCall(res, { requestId, created, model, toolCall }) {
  writeChatChunk(res, {
    requestId,
    created,
    model,
    delta: { role: "assistant", tool_calls: makeChatToolCallDelta(toolCall) },
  });
  return writeChatChunk(res, {
    requestId,
    created,
    model,
    delta: {},
    finishReason: "tool_calls",
  });
}

export function writeChatFinish(res, { requestId, created, model, finishReason = "stop" }) {
  return writeChatChunk(res, { requestId, created, model, delta: {}, finishReason });
}

export function writeResponseStart(res, responseId, model) {
  sseEvent(res, "response.created", {
    type: "response.created",
    response: makeResponseBase(responseId, model, "in_progress", []),
  });
  sseEvent(res, "response.in_progress", {
    type: "response.in_progress",
    response: makeResponseBase(responseId, model, "in_progress", []),
  });
}

export function writeResponseTextStart(res, responseId) {
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
    part: { type: "output_text", text: "", annotations: [] },
  });
  return itemId;
}

export function writeResponseTextDelta(res, responseId, delta) {
  return sseEvent(res, "response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: `${responseId}_msg`,
    output_index: 0,
    content_index: 0,
    delta,
  });
}

export function writeResponseTextDone(res, responseId, text) {
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
    part: { type: "output_text", text, annotations: [] },
  });
  sseEvent(res, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item,
  });
  return item;
}

export function writeResponseToolCall(res, responseId, toolCall, { remember } = {}) {
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
  remember?.(completedItem);
  return completedItem;
}

export function writeResponseCompleted(res, responseId, model, output) {
  sseEvent(res, "response.completed", {
    type: "response.completed",
    response: makeResponseBase(responseId, model, "completed", output),
  });
}
