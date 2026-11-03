// JSON Schema validation for mapped tool calls. No coercion or mutation occurs here.
import Ajv from "ajv";
import { resolveToolSpec } from "./mapping-registry.mjs";

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
const compiled = new WeakMap();

function getSchema(spec) {
  return spec?.parameters || spec?.input_schema || null;
}

function getValidator(schema) {
  if (!schema || typeof schema !== "object") return null;
  let validator = compiled.get(schema);
  if (!validator) {
    validator = ajv.compile(schema);
    compiled.set(schema, validator);
  }
  return validator;
}

function normalizeError(error) {
  return {
    path: error.instancePath || "/",
    keyword: error.keyword || "schema",
    message: error.message || "does not match schema",
    params: error.params || {},
  };
}

export function validateToolCallAgainstSchema(call, tools = []) {
  if (!call?.spec || call.mapping === "unresolved" || !resolveToolSpec(call.ir?.name || call.spec.name, tools).spec) {
    return {
      valid: false,
      errors: [{ path: "/name", keyword: "unknown_tool", message: "tool is not declared by the client", params: {} }],
    };
  }

  const schema = getSchema(call.spec);
  if (!schema) {
    return {
      valid: false,
      errors: [{ path: "/", keyword: "missing_schema", message: "tool schema is missing", params: {} }],
    };
  }

  let value;
  if (call.spec.kind === "custom") {
    value = call.arguments || "";
  } else {
    try {
      value = typeof call.arguments === "string" ? JSON.parse(call.arguments || "{}") : call.arguments;
    } catch {
      return {
        valid: false,
        errors: [{ path: "/", keyword: "invalid_json", message: "tool arguments are not valid JSON", params: {} }],
      };
    }
  }

  try {
    const validator = getValidator(schema);
    if (!validator) {
      return {
        valid: false,
        errors: [{ path: "/", keyword: "invalid_schema", message: "tool schema is not a JSON Schema object", params: {} }],
      };
    }
    const valid = Boolean(validator(value));
    return {
      valid,
      errors: valid ? [] : (validator.errors || []).map(normalizeError),
    };
  } catch (error) {
    return {
      valid: false,
      errors: [{ path: "/", keyword: "schema_error", message: error?.message || String(error), params: {} }],
    };
  }
}
