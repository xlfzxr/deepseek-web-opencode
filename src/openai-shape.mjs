// OpenAI-compatible request/response mapping helpers, independent of server state.
import { parseJsonMaybe } from "./dsml.mjs";

export function messagesToPrompt(messages = []) {
  if (!Array.isArray(messages)) return "";

  return messages
    .map((message) => {
      const role = message.role || "user";
      if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const calls = message.tool_calls
          .map((toolCall) => {
            const name = toolCall?.function?.name || toolCall?.name || "tool";
            const args = toolCall?.function?.arguments || toolCall?.arguments || "";
            return `${name}${args ? `(${args})` : ""}`;
          })
          .join(", ");
        return calls ? `assistant requested tools: ${calls}` : "";
      }

      let content = "";
      if (typeof message.content === "string") {
        content = message.content;
      } else if (Array.isArray(message.content)) {
        content = message.content
          .map((part) => {
            if (typeof part === "string") return part;
            if (typeof part?.text === "string") return part.text;
            if (typeof part?.content === "string") return part.content;
            return "";
          })
          .filter(Boolean)
          .join("\n");
      }
      if (role === "tool") {
        const name = message.name || message.tool_call_id || "tool";
        return content.trim() ? `tool result from ${name}: ${content.trim()}` : "";
      }
      return content.trim() ? `${role}: ${content.trim()}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function responseContentPartToText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (typeof part.input_text === "string") return part.input_text;
  if (typeof part.output_text === "string") return part.output_text;
  return "";
}

export function responseToolName(tool) {
  if (!tool || typeof tool !== "object") return "";
  const source = tool.function && typeof tool.function === "object" ? tool.function : tool;
  return String(source.name || tool.name || "").trim();
}

export function responseToolDescription(tool) {
  if (!tool || typeof tool !== "object") return "";
  const source = tool.function && typeof tool.function === "object" ? tool.function : tool;
  return String(source.description || tool.description || "").trim();
}

export function responseToolParameters(tool) {
  if (!tool || typeof tool !== "object") return {};
  const source = tool.function && typeof tool.function === "object" ? tool.function : tool;
  return source.parameters || source.input_schema || tool.parameters || tool.input_schema || {};
}

export function extractResponseTools(body = {}) {
  if (!Array.isArray(body.tools)) return [];

  const tools = [];
  for (const tool of body.tools) {
    if (!tool || typeof tool !== "object") continue;

    if (tool.type === "custom") {
      const name = responseToolName(tool);
      if (!name) continue;
      tools.push({
        kind: "custom",
        name,
        wireName: name,
        description: responseToolDescription(tool),
        parameters: { type: "string" },
      });
      continue;
    }

    if (tool.type === "tool_search") {
      tools.push({
        kind: "tool_search",
        name: "tool_search",
        wireName: "tool_search",
        description: "Search and load available Codex tools.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
          },
        },
      });
      continue;
    }

    const name = responseToolName(tool);
    if (!name) continue;
    const namespace = String(tool.namespace || tool.function?.namespace || "").trim();
    tools.push({
      kind: "function",
      name,
      wireName: namespace ? `${namespace}.${name}` : name,
      namespace,
      description: responseToolDescription(tool),
      parameters: responseToolParameters(tool),
    });
  }

  return tools;
}

export function extractChatTools(body = {}) {
  if (!Array.isArray(body.tools)) return [];

  return body.tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") return null;
      const name = responseToolName(tool);
      if (!name) return null;
      return {
        kind: "function",
        name,
        wireName: name,
        description: responseToolDescription(tool),
        parameters: responseToolParameters(tool),
      };
    })
    .filter(Boolean);
}

export function stringifyForPrompt(value, maxChars = 1800) {
  let text = "";
  try {
    text = JSON.stringify(value ?? {}, null, 2);
  } catch {
    text = String(value ?? "");
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

export function buildToolPrompt(tools) {
  if (!tools.length) return "";

  const definitions = tools.map((tool) => ({
    name: tool.wireName,
    type: tool.kind,
    description: tool.description,
    parameters: tool.parameters,
  }));

  return [
    "system: You have access to client-side tools. Use a tool when it is needed to inspect files, run commands, edit files, or fetch external context.",
    "When you use a normal function tool, reply with ONLY this XML and no extra text:",
    '<tool_call name="TOOL_NAME">{"arg":"value"}</tool_call>',
    "When you use a custom/raw-input tool such as apply_patch, put the raw input inside the tag and preserve formatting exactly:",
    '<tool_call name="apply_patch">RAW_INPUT_HERE</tool_call>',
    "If no tool is needed, answer normally.",
    "Available tools:",
    stringifyForPrompt(definitions, 30000),
  ].join("\n");
}

export function chatCompletionsToPrompt(body, tools = extractChatTools(body)) {
  const parts = [];
  const toolPrompt = buildToolPrompt(tools);
  if (toolPrompt) {
    parts.push(toolPrompt);
  }
  const messagePrompt = messagesToPrompt(body.messages);
  if (messagePrompt) {
    parts.push(messagePrompt);
  }
  return parts.join("\n\n");
}

export function makeResponseBase(responseId, model, status, output = []) {
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function makeResponseMessageItem(itemId, status, text = "") {
  return {
    id: itemId,
    type: "message",
    status,
    role: "assistant",
    content:
      status === "completed"
        ? [
            {
              type: "output_text",
              text,
              annotations: [],
            },
          ]
        : [],
  };
}

export function makeFunctionCallItem(itemId, status, callId, spec, argumentsText = "") {
  const item = {
    id: itemId,
    type: "function_call",
    status,
    call_id: callId,
    name: spec.name,
    arguments: argumentsText,
  };
  if (spec.namespace) {
    item.namespace = spec.namespace;
  }
  return item;
}

export function makeCustomToolCallItem(itemId, status, callId, spec, input = "") {
  return {
    id: itemId,
    type: "custom_tool_call",
    status,
    call_id: callId,
    name: spec.name,
    input,
  };
}

export function makeToolSearchCallItem(itemId, status, callId, argumentsText = "{}") {
  return {
    id: itemId,
    type: "tool_search_call",
    status,
    call_id: callId,
    execution: "client",
    arguments: parseJsonMaybe(argumentsText) || {},
  };
}

export function makeToolCallItem(itemId, status, callId, toolCall, payload = "") {
  if (toolCall.spec.kind === "custom") {
    return makeCustomToolCallItem(itemId, status, callId, toolCall.spec, payload);
  }
  if (toolCall.spec.kind === "tool_search") {
    return makeToolSearchCallItem(itemId, status, callId, payload);
  }
  return makeFunctionCallItem(itemId, status, callId, toolCall.spec, payload);
}
