// OpenAI-compatible JSON response payloads (chat.completion + response objects).
//
// Transport serializes; orchestration already decided text vs tool call.

import {
  makeResponseBase,
  makeResponseMessageItem,
  makeToolCallItem,
} from "../openai-shape.mjs";
import { makeChatToolCall } from "./openai-sse.mjs";

const ZERO_USAGE = Object.freeze({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
});

export function chatCompletionJson({ requestId, created, model, content, toolCall }) {
  if (toolCall) {
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
            tool_calls: [makeChatToolCall(toolCall)],
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

export function responsesJson({ responseId, model, content, toolCall, remember }) {
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
    remember?.(item);
    return makeResponseBase(responseId, model, "completed", [item]);
  }

  return makeResponseBase(responseId, model, "completed", [
    makeResponseMessageItem(`${responseId}_msg`, "completed", content),
  ]);
}
