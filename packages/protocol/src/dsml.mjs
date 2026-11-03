// Tolerant prompt-driven tool-call parser (DSML first, with legacy fallbacks).
import { createToolCallIR } from "./tool-call-ir.mjs";

function findToolSpec(name, tools = []) {
  const normalized = String(name || "").trim();
  if (!normalized) return null;
  return (
    tools.find((tool) => tool.wireName === normalized || tool.name === normalized) || {
      kind: "function",
      name: normalized,
      wireName: normalized,
    }
  );
}

function parseToolAttributes(raw = "") {
  const attrs = {};
  const quoted = /([:\w.-]+)\s*=\s*(["'])(.*?)\2/g;
  for (const match of raw.matchAll(quoted)) {
    attrs[match[1]] = decodeXmlEntities(match[3]);
  }

  const unquoted = /([:\w.-]+)\s*=\s*([^\s"'=<>`]+)/g;
  for (const match of raw.matchAll(unquoted)) {
    if (attrs[match[1]] === undefined) attrs[match[1]] = decodeXmlEntities(match[2]);
  }
  return attrs;
}

function decodeXmlEntities(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function decodeXmlValues(value) {
  if (typeof value === "string") return decodeXmlEntities(value);
  if (Array.isArray(value)) return value.map(decodeXmlValues);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeXmlValues(entry)]));
  }
  return value;
}

function stripCodeFence(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```[\w-]*\s*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

export function normalizeDsmlText(text) {
  return String(text || "").replace(/\uFF5C/g, "|").trim();
}

export function parseJsonMaybe(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const opens = (text.match(/\{/g) || []).length;
    const closes = (text.match(/\}/g) || []).length;
    if (opens > closes) {
      try {
        return JSON.parse(`${text}${"}".repeat(opens - closes)}`);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractFirstJsonObject(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }

  return raw.slice(start);
}

function normalizeFunctionArguments(raw) {
  const cleaned = stripCodeFence(raw);
  if (!cleaned) return "{}";
  const parsed = parseJsonMaybe(cleaned);
  if (parsed && typeof parsed === "object") {
    if (parsed.parameters && typeof parsed.parameters === "object") {
      return JSON.stringify(parsed.parameters);
    }
    if (parsed.arguments && typeof parsed.arguments === "object") {
      return JSON.stringify(parsed.arguments);
    }
    return JSON.stringify(parsed);
  }
  return JSON.stringify({ input: cleaned });
}

function normalizeCustomInput(raw) {
  const cleaned = stripCodeFence(raw);
  const parsed = parseJsonMaybe(cleaned);
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.input === "string") return parsed.input;
    if (typeof parsed.arguments?.input === "string") return parsed.arguments.input;
    if (typeof parsed.parameters?.input === "string") return parsed.parameters.input;
  }
  return cleaned;
}

function parseToolJsonObject(obj, tools) {
  if (!obj || typeof obj !== "object") return null;
  const name = obj.tool || obj.name || obj.function?.name;
  if (!name) return null;
  const spec = findToolSpec(name, tools);
  const rawArguments =
    obj.parameters ?? obj.arguments ?? obj.function?.arguments ?? (spec.kind === "custom" ? obj.input : {});
  return {
    spec,
    id: obj.id || obj.call_id || "",
    arguments:
      spec.kind === "custom"
        ? normalizeCustomInput(typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments ?? ""))
        : normalizeFunctionArguments(
            typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments ?? {}),
          ),
  };
}

const DSML_PREFIX = "(?:\\s*\\|\\s*DSML\\s*\\|\\s*)?";

function parseDsmlToolCalls(text, tools) {
  const raw = normalizeDsmlText(text);
  if (!/DSML/i.test(raw) && !/<invoke\s+name\s*=/i.test(raw)) return [];

  const invokePattern = new RegExp(
    `<${DSML_PREFIX}invoke\\b([^>]*)>([\\s\\S]*?)(?:<\\/\\s*${DSML_PREFIX}invoke\\s*>|(?=<${DSML_PREFIX}invoke\\b)|$)`,
    "gi",
  );
  const parameterPattern = new RegExp(
    `<${DSML_PREFIX}parameter\\b([^>]*)>([\\s\\S]*?)(?:<\\/\\s*${DSML_PREFIX}parameter\\s*>|(?=<${DSML_PREFIX}parameter\\b)|$)`,
    "gi",
  );
  const calls = [];

  for (const invoke of raw.matchAll(invokePattern)) {
    const attrs = parseToolAttributes(invoke[1]);
    const name = String(attrs.name || "").trim();
    if (!name) continue;
    const spec = findToolSpec(name, tools);
    const args = {};

    for (const parameter of invoke[2].matchAll(parameterPattern)) {
      const parameterAttrs = parseToolAttributes(parameter[1]);
      const parameterName = String(parameterAttrs.name || "").trim();
      if (!parameterName) continue;
      const value = decodeXmlEntities(parameter[2]);
      if (String(parameterAttrs.string || "true").toLowerCase() === "false") {
        const parsed = parseJsonMaybe(value);
        args[parameterName] = parsed === null ? value : decodeXmlValues(parsed);
      } else {
        args[parameterName] = value;
      }
    }

    if (spec.kind === "custom") {
      const input = typeof args.input === "string" ? args.input : JSON.stringify(args);
      calls.push({ spec, id: attrs.id || "", arguments: normalizeCustomInput(input) });
    } else {
      calls.push({ spec, id: attrs.id || "", arguments: JSON.stringify(args) });
    }
  }
  return calls;
}

function parseFallbackToolCall(text, tools) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const xml = raw.match(/<tool_call\b([^>]*)>([\s\S]*?)(?:<\/tool_call>|$)/i);
  if (xml) {
    const attrs = parseToolAttributes(xml[1]);
    const body = stripCodeFence(xml[2]);
    const parsedBody = parseJsonMaybe(body);
    const name = attrs.name || parsedBody?.tool || parsedBody?.name || parsedBody?.function?.name;
    if (!name) return null;
    const spec = findToolSpec(name, tools);
    return {
      spec,
      id: attrs.id || parsedBody?.id || parsedBody?.call_id || "",
      arguments: spec.kind === "custom" ? normalizeCustomInput(body) : normalizeFunctionArguments(body),
    };
  }

  const fenced = raw.match(/```(?:tool_json|json)\s*\n?([\s\S]*?)\n?```/i);
  if (fenced) {
    const parsed = parseJsonMaybe(fenced[1]);
    const call = parseToolJsonObject(parsed, tools);
    if (call) return call;
  }

  const parsed = parseJsonMaybe(raw);
  const directCall = parseToolJsonObject(parsed, tools);
  if (directCall) return directCall;

  const mentionedTool = (Array.isArray(tools) ? tools : []).find((tool) => {
    const name = String(tool.wireName || tool.name || "").trim();
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      name &&
      new RegExp(
        `(?:\\u8c03\\u7528|\\u4f7f\\u7528|call|use)\\s*(?:\\u5de5\\u5177\\s*)?${escapedName}`,
        "i",
      ).test(raw)
    );
  });
  if (!mentionedTool) return null;

  const jsonText = extractFirstJsonObject(raw);
  const jsonObj = parseJsonMaybe(jsonText);
  const args =
    jsonObj && typeof jsonObj === "object" && !jsonObj.tool && !jsonObj.name && !jsonObj.function
      ? jsonObj
      : jsonObj?.arguments || jsonObj?.parameters || {};
  return {
    spec: mentionedTool,
    id: jsonObj?.id || jsonObj?.call_id || "",
    arguments:
      mentionedTool.kind === "custom"
        ? normalizeCustomInput(typeof args === "string" ? args : JSON.stringify(args ?? ""))
        : normalizeFunctionArguments(typeof args === "string" ? args : JSON.stringify(args ?? {})),
  };
}

function callConfidence(raw, source) {
  const normalized = normalizeDsmlText(raw);
  if (source === "dsml") {
    return /<\/\s*(?:\|\s*DSML\s*\|\s*)?invoke\s*>/i.test(normalized) ? 0.98 : 0.78;
  }
  if (/<tool_call\b[\s\S]*?<\/tool_call>/i.test(raw)) return 0.92;
  if (/```(?:tool_json|json)/i.test(raw)) return 0.86;
  if (parseJsonMaybe(raw)) return 0.82;
  return 0.65;
}

function attachIR(call, raw, source) {
  let params;
  if (call.spec.kind === "custom") {
    params = { input: call.arguments };
  } else {
    const parsed = parseJsonMaybe(call.arguments);
    params = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }
  const ir = createToolCallIR({
    name: call.spec.wireName || call.spec.name,
    params,
    raw,
    confidence: callConfidence(raw, source),
    source,
  });
  return { ...call, ir };
}

export function parseToolCallsFromText(text, tools = []) {
  const originalRaw = String(text || "").trim();
  const normalized = normalizeDsmlText(originalRaw);
  if (!normalized) return [];

  const toolList = Array.isArray(tools) ? tools : [];
  const dsmlCalls = parseDsmlToolCalls(normalized, toolList);
  if (dsmlCalls.length) {
    return dsmlCalls.map((call) => attachIR(call, originalRaw, "dsml"));
  }

  const fallback = parseFallbackToolCall(normalized, toolList);
  return fallback ? [attachIR(fallback, originalRaw, "fallback")] : [];
}

export function parseToolCallFromText(text, tools = []) {
  return parseToolCallsFromText(text, tools)[0] || null;
}

export function parseToolCallIRsFromText(text, tools = []) {
  return parseToolCallsFromText(text, tools).map((call) => call.ir);
}
