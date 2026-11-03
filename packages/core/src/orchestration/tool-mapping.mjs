// Convert provider-neutral tool-call IR into a tool call matching the supplied schema.
import { createToolCallIR } from "@deepseek-web-opencode/protocol/tool-call-ir";
import { coerceObjectToSchema } from "./coercer.mjs";
import { buildNestedObject } from "./nested-builder.mjs";
import { canonicalToolName, resolveParameterName, resolveToolSpec } from "./mapping-registry.mjs";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parameterSchema(spec) {
  return spec?.parameters || spec?.input_schema || {};
}

function normalizeNestedKeys(value, schema, toolName) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeNestedKeys(entry, schema?.items || {}, toolName));
  }
  if (!isPlainObject(value)) return value;

  const properties = schema?.properties || {};
  const result = {};
  for (const [rawKey, entry] of Object.entries(value)) {
    if (rawKey === "__proto__" || rawKey === "prototype" || rawKey === "constructor") continue;
    const key = resolveParameterName(toolName, rawKey, properties);
    const childSchema = properties[key] || schema?.additionalProperties || {};
    result[key] = normalizeNestedKeys(entry, childSchema, toolName);
  }
  return result;
}

export function mapToolCallIRToSchema(ir, tools = [], fallbackSpec = null) {
  if (!ir?.name) return null;
  const match = resolveToolSpec(ir.name, tools);
  const spec = match.spec || fallbackSpec || {
    kind: "function",
    name: ir.name,
    wireName: ir.name,
    parameters: {},
  };
  const canonicalName = spec.wireName || spec.name || canonicalToolName(ir.name);

  if (spec.kind === "custom") {
    const input = typeof ir.params?.input === "string" ? ir.params.input : JSON.stringify(ir.params || {});
    const mappedIR = createToolCallIR({ ...ir, name: canonicalName, params: { input } });
    return { ir: mappedIR, spec, params: { input }, match: match.method };
  }

  const schema = parameterSchema(spec);
  const nested = buildNestedObject(ir.params, { toolName: canonicalName, schema });
  const parsed = coerceObjectToSchema(nested, schema);
  const mappedKeys = normalizeNestedKeys(parsed, schema, canonicalName);
  const params = coerceObjectToSchema(mappedKeys, schema);
  const mappedIR = createToolCallIR({ ...ir, name: canonicalName, params });
  return { ir: mappedIR, spec, params, match: match.method };
}
