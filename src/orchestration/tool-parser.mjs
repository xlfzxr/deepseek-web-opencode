// Tool-call parsing boundary: orchestration interprets provider text into a tool call.
//
// Kept in one module so the transport layer never imports the DSML parser directly.

export { parseToolCallFromText } from "../dsml.mjs";
