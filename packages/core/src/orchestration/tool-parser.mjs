// Tool-call parsing boundary: protocol parses provider text; core maps its IR to client schemas.
import { parseToolCallsFromText as parseProtocolToolCalls } from "@deepseek-web-opencode/protocol/dsml";
import { mapToolCallIRToSchema } from "./tool-mapping.mjs";

export function parseToolCallsFromText(text, tools = []) {
  return parseProtocolToolCalls(text, tools).map((parsed) => {
    const mapped = mapToolCallIRToSchema(parsed.ir, tools, parsed.spec);
    if (!mapped) return parsed;
    return {
      ...parsed,
      spec: mapped.spec,
      ir: mapped.ir,
      mapping: mapped.match,
      arguments:
        mapped.spec.kind === "custom"
          ? mapped.params.input || ""
          : JSON.stringify(mapped.params),
    };
  });
}

// Backward-compatible single-call helper for callers that only consume one item.
export function parseToolCallFromText(text, tools = []) {
  return parseToolCallsFromText(text, tools)[0] || null;
}
