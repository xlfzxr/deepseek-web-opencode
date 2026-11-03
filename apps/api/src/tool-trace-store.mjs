// Local-only JSONL traces for DSML parser tuning and offline replay.
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

function safeRequestId(value) {
  const id = String(value || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
  return id && id !== "." && id !== ".." ? id : "unknown";
}

function compactTools(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    kind: tool.kind,
    name: tool.name,
    wireName: tool.wireName,
    namespace: tool.namespace,
    parameters: tool.parameters,
    input_schema: tool.input_schema,
  }));
}

export function createToolTraceStore({
  enabled = true,
  dir = path.resolve(process.cwd(), ".deepseek-tool-traces"),
} = {}) {
  async function record(entry = {}) {
    if (!enabled) return null;
    const requestId = safeRequestId(entry.requestId);
    const filePath = path.join(dir, `${requestId}.jsonl`);
    const record = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      ...entry,
      requestId,
      tools: compactTools(entry.tools),
    };
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {});
      await appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(filePath, 0o600).catch(() => {});
      return filePath;
    } catch {
      // Trace persistence is best-effort and must never fail a completion request.
      return null;
    }
  }

  async function read(requestId) {
    const filePath = path.join(dir, `${safeRequestId(requestId)}.jsonl`);
    try {
      const content = await readFile(filePath, "utf8");
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  return { record, read, dir, enabled: Boolean(enabled) };
}
