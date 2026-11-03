// OpenAI-compatible SSE frame serialization (chat.completion.chunk + response.* events).
//
// Transport owns writing bytes. It receives already-normalized tool calls from
// orchestration and never talks to the DeepSeek adapter.

import {
  makeResponseBase,
  makeResponseMessageItem,
  makeToolCallItem,
} from "@deepseek-web-opencode/protocol/openai-shape";
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

export function makeChatToolCall(toolCall, index = 0) {
  const callId = toolCall.id || `call_ds_${Date.now()}_${index}`;
  return {
    id: callId,
    type: "function",
    function: {
      name: toolCall.spec.name,
      arguments: toolCall.arguments || "{}",
    },
  };
}

export function makeChatToolCallDelta(toolCall, index = 0) {
  const callId = toolCall.id || `call_ds_${Date.now()}_${index}`;
  return {
    index,
    id: callId,
    type: "function",
    function: {
      name: toolCall.spec.name,
      arguments: toolCall.arguments || "{}",
    },
  };
}

export function writeChatToolCalls(res, { requestId, created, model, toolCalls }) {
  // One delta per tool call, matching OpenAI's streaming shape. Sending every call in a
  // single delta makes clients that merge by index keep only the first call.
  for (const [index, toolCall] of toolCalls.entries()) {
    writeChatChunk(res, {
      requestId,
      created,
      model,
      delta: {
        role: "assistant",
        tool_calls: [makeChatToolCallDelta(toolCall, index)],
      },
    });
  }
  return writeChatChunk(res, {
    requestId,
    created,
    model,
    delta: {},
    finishReason: "tool_calls",
  });
}

export function writeChatToolCall(res, options) {
  return writeChatToolCalls(res, { ...options, toolCalls: [options.toolCall] });
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

export function writeResponseToolCall(res, responseId, toolCall, { remember, outputIndex = 0 } = {}) {
  const itemIdPrefix = toolCall.spec.kind === "custom" ? "ctc" : "fc";
  const itemId = `${responseId}_${itemIdPrefix}_${outputIndex}`;
  const callId = toolCall.id || `call_ds_${Date.now()}_${outputIndex}`;
  const payload = toolCall.arguments || (toolCall.spec.kind === "custom" ? "" : "{}");
  const inProgressItem = makeToolCallItem(itemId, "in_progress", callId, toolCall, "");
  const completedItem = makeToolCallItem(itemId, "completed", callId, toolCall, payload);

  sseEvent(res, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: inProgressItem,
  });

  if (toolCall.spec.kind === "custom") {
    if (payload) {
      sseEvent(res, "response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta",
        item_id: itemId,
        output_index: outputIndex,
        delta: payload,
      });
    }
    sseEvent(res, "response.custom_tool_call_input.done", {
      type: "response.custom_tool_call_input.done",
      item_id: itemId,
      output_index: outputIndex,
      input: payload,
    });
  } else if (toolCall.spec.kind !== "tool_search") {
    if (payload) {
      sseEvent(res, "response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: itemId,
        output_index: outputIndex,
        delta: payload,
      });
    }
    sseEvent(res, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: outputIndex,
      arguments: payload,
    });
  }

  sseEvent(res, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: outputIndex,
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
