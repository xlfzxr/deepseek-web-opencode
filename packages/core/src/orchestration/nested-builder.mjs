// Rebuild dotted/bracketed DSML parameter names into schema-shaped objects/arrays.
import { resolveParameterName } from "./mapping-registry.mjs";

const BLOCKED_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function tokenizePath(rawPath) {
  const normalized = String(rawPath || "").trim().replace(/\[(\d+)\]/g, ".$1");
  const segments = normalized.split(".").filter(Boolean);
  if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment))) return [];
  return segments;
}

function schemaForSegment(schema, segment) {
  if (/^\d+$/.test(segment)) return schema?.items || {};
  return schema?.properties?.[segment] || schema?.additionalProperties || {};
}

function mapPath(toolName, segments, schema) {
  const mapped = [];
  let currentSchema = schema || {};
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) {
      mapped.push(Number(segment));
    } else {
      const properties = currentSchema?.properties || {};
      mapped.push(resolveParameterName(toolName, segment, properties));
    }
    currentSchema = schemaForSegment(currentSchema, String(mapped.at(-1)));
  }
  return mapped;
}

function newContainer(nextSegment) {
  return typeof nextSegment === "number" || /^\d+$/.test(String(nextSegment)) ? [] : {};
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function setPath(root, path, value) {
  let current = root;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    const key = typeof segment === "number" ? segment : String(segment);
    const isLast = index === path.length - 1;
    if (isLast) {
      current[key] = value;
      return;
    }

    const next = path[index + 1];
    if (!hasOwn(current, key) || !current[key] || typeof current[key] !== "object") {
      current[key] = newContainer(next);
    }
    current = current[key];
  }
}

export function buildNestedObject(params = {}, { toolName = "", schema = {} } = {}) {
  const root = {};
  if (!params || typeof params !== "object" || Array.isArray(params)) return root;

  for (const [rawPath, value] of Object.entries(params)) {
    const segments = tokenizePath(rawPath);
    if (!segments.length) continue;
    setPath(root, mapPath(toolName, segments, schema), value);
  }
  return root;
}
