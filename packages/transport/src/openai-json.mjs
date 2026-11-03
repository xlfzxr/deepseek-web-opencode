// OpenAI-compatible JSON response payloads (chat.completion + response objects).
//
// Transport serializes; orchestration already decided text vs tool call.

import {
  makeResponseBase,
  makeResponseMessageItem,
  makeToolCallItem,
} from "@deepseek-web-opencode/protocol/openai-shape";
import { makeChatToolCall } from "./openai-sse.mjs";

const ZERO_USAGE = Object.freeze({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
});

export function chatCompletionJson({ requestId, created, model, content, toolCall, toolCalls }) {
  const calls = Array.isArray(toolCalls) ? toolCalls : toolCall ? [toolCall] : [];
  if (calls.length) {
    return {
      id: requestId,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: calls.map((call, index) => makeChatToolCall(call, index)),
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: ZERO_USAGE,
    };
  }

  return {
    id: requestId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: ZERO_USAGE,
  };
}

export function responsesJson({ responseId, model, content, toolCall, toolCalls, remember }) {
  const calls = Array.isArray(toolCalls) ? toolCalls : toolCall ? [toolCall] : [];
  if (calls.length) {
    const items = calls.map((call, index) => {
      const prefix = call.spec.kind === "custom" ? "ctc" : "fc";
      const itemId = `${responseId}_${prefix}_${index}`;
      const callId = call.id || `call_ds_${Date.now()}_${index}`;
      const item = makeToolCallItem(
        itemId,
        "completed",
        callId,
        call,
        call.arguments || (call.spec.kind === "custom" ? "" : "{}"),
      );
      remember?.(item);
      return item;
    });
    return makeResponseBase(responseId, model, "completed", items);
  }

  return makeResponseBase(responseId, model, "completed", [
    makeResponseMessageItem(`${responseId}_msg`, "completed", content),
  ]);
}
