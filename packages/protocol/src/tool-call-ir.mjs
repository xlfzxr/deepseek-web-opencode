// Canonical, transport-neutral representation of a parsed model tool invocation.
// The raw response is retained in memory for validation/repair and optional trace logging.

export const TOOL_CALL_IR_VERSION = 1;
const VALID_SOURCES = new Set(["dsml", "fallback"]);

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function normalizeParams(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (value === undefined || value === null) return {};
  return { input: value };
}

export function createToolCallIR({
  name,
  params,
  raw = "",
  confidence = 0,
  source = "fallback",
} = {}) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) return null;

  return {
    name: normalizedName,
    params: normalizeParams(params),
    raw: String(raw ?? ""),
    confidence: normalizeConfidence(confidence),
    source: VALID_SOURCES.has(source) ? source : "fallback",
  };
}
