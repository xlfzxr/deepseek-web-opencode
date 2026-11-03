// DeepSeek tool-call parsing (DSML/XML/JSON heuristics), independent of transport.
function findToolSpec(name, tools) {
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
    attrs[match[1]] = match[3];
  }

  const unquoted = /([:\w.-]+)\s*=\s*([^\s"'=<>`]+)/g;
  for (const match of raw.matchAll(unquoted)) {
    if (!attrs[match[1]]) attrs[match[1]] = match[2];
  }
  return attrs;
}

function stripCodeFence(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```[\w-]*\s*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : trimmed;
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

function parseDsmlToolCall(text, tools) {
  const raw = String(text || "").replace(/\uFF5C+/g, "|");
  if (!/DSML/i.test(raw) && !/<invoke\s+name=/i.test(raw)) return null;
  const dsml = "\\|*DSML\\|*";
  const prefix = `(?:${dsml}\\s*)?`;
  const invoke = raw.match(
    new RegExp(
      `<${prefix}invoke\\s+name=["']([^"']+)["']\\s*>([\\s\\S]*?)(?:</\\s*${prefix}invoke>|$)`,
      "i",
    ),
  );
  if (!invoke) return null;
  const name = invoke[1].trim();
  if (!name) return null;
  const spec = findToolSpec(name, tools);
  const args = {};
  const parameterRe = new RegExp(
    `<${prefix}parameter\\s+name=["']([^"']+)["'](?:\\s+string=["'](true|false)["'])?\\s*>([\\s\\S]*?)</\\s*${prefix}parameter>`,
    "gi",
  );
  for (const match of invoke[2].matchAll(parameterRe)) {
    const value = match[3];
    if (match[2] === "false") {
      const parsed = parseJsonMaybe(value);
      args[match[1]] = parsed === null ? value : parsed;
    } else {
      args[match[1]] = value;
    }
  }
  if (spec.kind === "custom") {
    const input = typeof args.input === "string" ? args.input : JSON.stringify(args);
    return { spec, id: "", arguments: normalizeCustomInput(input) };
  }
  return { spec, id: "", arguments: JSON.stringify(args) };
}

export function parseToolCallFromText(text, tools) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const dsml = parseDsmlToolCall(raw, tools);
  if (dsml) return dsml;

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

  const mentionedTool = tools.find((tool) => {
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
  if (mentionedTool) {
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

  return null;
}
