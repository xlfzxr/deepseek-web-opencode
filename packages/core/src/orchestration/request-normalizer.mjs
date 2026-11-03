// Request normalization: turn OpenAI-shaped HTTP bodies into pipeline input.
//
// Contract: orchestration normalizes input before the adapter is invoked. This module is
// pure (injected lookups only) so the transport layer never needs to know prompt formats.

import {
  buildToolPromptSpec,
  chatCompletionsToPrompt,
  extractChatTools,
  extractResponseTools,
  responseContentPartToText,
  stringifyForPrompt,
} from "@deepseek-web-opencode/protocol/openai-shape";

export function sessionKeyFromBody(body = {}) {
  return body.user || body.metadata?.session_id || body.session_id || "default";
}

export function responsesSessionKeyFromBody(body = {}, lookupSession = () => undefined) {
  const previous = body.previous_response_id;
  if (previous) {
    const known = lookupSession(previous);
    if (known) return known;
  }
  return body.metadata?.session_id || body.session_id || body.user || "responses-default";
}

export function responseInputItemToText(item, { lookupToolCall = () => undefined, remember } = {}) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";

  const type = item.type || "message";
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const output =
      responseContentPartToText(item.output) || responseContentPartToText(item.content);
    const callId = item.call_id || item.id || "";
    const cached = callId ? lookupToolCall(callId) : null;
    const toolName = item.name || cached?.name || "tool";
    return output ? `tool result from ${toolName}${callId ? ` (${callId})` : ""}: ${output}` : "";
  }

  if (type === "function_call" || type === "custom_tool_call" || type === "tool_search_call") {
    remember?.(item);
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

export function responsesToPrompt(body = {}, options = {}) {
  const tools = options.tools || extractResponseTools(body);
  const lookup = {
    lookupToolCall: options.lookupToolCall,
    remember: options.remember,
  };
  const parts = [];

  const instructions = responseContentPartToText(body.instructions);
  if (instructions.trim()) {
    parts.push(`system: ${instructions.trim()}`);
  }

  const toolPromptSpec = options.toolPromptSpec || buildToolPromptSpec(tools);
  if (toolPromptSpec.text) {
    parts.push(toolPromptSpec.text);
  }

  if (typeof body.input === "string") {
    parts.push(`user: ${body.input.trim()}`);
  } else if (Array.isArray(body.input)) {
    parts.push(...body.input.map((item) => responseInputItemToText(item, lookup)).filter(Boolean));
  } else if (body.input && typeof body.input === "object") {
    const text = responseInputItemToText(body.input, lookup);
    if (text) parts.push(text);
  }

  return parts.join("\n\n");
}

export function normalizeChatRequest(body = {}, { defaultModel } = {}) {
  const tools = extractChatTools(body);
  const toolPromptSpec = buildToolPromptSpec(tools);
  const usesToolPrompt = tools.length > 0 && !body.prompt;
  return {
    sessionKey: sessionKeyFromBody(body),
    model: body.model || defaultModel,
    prompt: body.prompt || chatCompletionsToPrompt(body, tools, toolPromptSpec),
    promptVersion: usesToolPrompt ? toolPromptSpec.version : null,
    promptHash: usesToolPrompt ? toolPromptSpec.hash : null,
    searchEnabled: Boolean(body.search_enabled),
    tools,
  };
}

export function normalizeResponsesRequest(body = {}, options = {}) {
  const tools = extractResponseTools(body);
  const toolPromptSpec = buildToolPromptSpec(tools);
  return {
    sessionKey: responsesSessionKeyFromBody(body, options.lookupSession),
    model: body.model || options.defaultModel,
    prompt: responsesToPrompt(body, { ...options, tools, toolPromptSpec }),
    promptVersion: tools.length ? toolPromptSpec.version : null,
    promptHash: tools.length ? toolPromptSpec.hash : null,
    searchEnabled: Boolean(body.search_enabled),
    tools,
  };
}
