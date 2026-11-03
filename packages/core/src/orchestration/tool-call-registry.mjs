// Tool-call registry: remembers what a call_id meant so later turns can label results.
//
// Leaf module (no project imports). Bounded so a long-lived agent session cannot grow
// the map without limit.

export function createToolCallRegistry({ limit = 500 } = {}) {
  const entries = new Map();
  const max = Math.max(1, Math.trunc(limit) || 500);

  function remember(item) {
    const callId = item?.call_id || item?.id;
    if (!callId) return null;
    const entry = {
      name: item.name || "tool",
      type: item.type || "function_call",
    };
    entries.set(callId, entry);
    while (entries.size > max) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return entry;
  }

  function get(callId) {
    return callId ? entries.get(callId) : undefined;
  }

  return { remember, get, size: () => entries.size, clear: () => entries.clear() };
}
