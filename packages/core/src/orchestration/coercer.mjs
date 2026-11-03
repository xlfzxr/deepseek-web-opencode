// Best-effort schema-directed conversion for values emitted as DSML strings.

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function typeOfSchema(schema, value) {
  if (Array.isArray(schema?.type)) {
    if (value === null && schema.type.includes("null")) return "null";
    const current = Array.isArray(value) ? "array" : isPlainObject(value) ? "object" : typeof value;
    if (schema.type.includes(current)) return current;
    return schema.type.find((type) => type !== "null") || schema.type[0];
  }
  if (typeof schema?.type === "string") return schema.type;
  if (schema?.properties || schema?.additionalProperties) return "object";
  if (schema?.items) return "array";
  return "";
}

function parseJsonString(value) {
  if (typeof value !== "string") return { parsed: false, value };
  const text = value.trim();
  if (!text) return { parsed: false, value };
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false, value };
  }
}

function coerceNumber(value, integer) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return value;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) return value;
  return parsed;
}

function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "on":
      return true;
    case "false":
    case "0":
    case "no":
    case "off":
      return false;
    default:
      return value;
  }
}

export function coerceValue(value, schema = {}) {
  const type = typeOfSchema(schema, value);
  if (type === "object") {
    let candidate = value;
    if (typeof candidate === "string") {
      const parsed = parseJsonString(candidate);
      if (parsed.parsed) candidate = parsed.value;
    }
    if (!isPlainObject(candidate)) return candidate;

    const result = {};
    for (const [key, entry] of Object.entries(candidate)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
      const propertySchema = schema.properties?.[key] || schema.additionalProperties || {};
      result[key] = coerceValue(entry, propertySchema);
    }
    return result;
  }

  if (type === "array") {
    let candidate = value;
    if (!Array.isArray(candidate)) {
      const parsed = parseJsonString(candidate);
      if (parsed.parsed) candidate = parsed.value;
    }
    if (!Array.isArray(candidate)) return candidate;
    return candidate.map((entry) => coerceValue(entry, schema.items || {}));
  }

  if (type === "integer") return coerceNumber(value, true);
  if (type === "number") return coerceNumber(value, false);
  if (type === "boolean") return coerceBoolean(value);
  if (type === "null" && value === "null") return null;
  if (type === "string" && value !== null && value !== undefined && typeof value !== "string") {
    return String(value);
  }
  return value;
}

export function coerceObjectToSchema(value, schema = {}) {
  const coerced = coerceValue(value, { ...schema, type: schema.type || "object" });
  return isPlainObject(coerced) ? coerced : value;
}
