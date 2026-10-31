// tool-loop: single-hop tool detection around the pipeline.
//
// Contract: this gateway is OpenAI-compatible, so tool *execution* belongs to the
// client. After one tool call the bridge must stop and let the caller send the tool
// result in a new request; continuing upstream here would duplicate the assistant turn.
// `budget` is the hard cap on upstream rounds (default 1, max 8) so a future multi-step
// mode still cannot loop forever.
import { evToolDone } from "./events.mjs";

export const DEFAULT_TOOL_BUDGET = 1;
const MAX_TOOL_BUDGET = 8;

export async function* runToolLoop({
  pipeline,
  normalized,
  tools = [],
  budget = DEFAULT_TOOL_BUDGET,
  ctx,
  signal,
  parseToolCall,
}) {
  const parsedBudget = Number(budget);
  const rounds = Math.max(
    1,
    Math.min(MAX_TOOL_BUDGET, Number.isFinite(parsedBudget) && parsedBudget > 0 ? Math.trunc(parsedBudget) : DEFAULT_TOOL_BUDGET),
  );

  for (let round = 0; round < rounds; round += 1) {
    let fullText = "";
    for await (const event of pipeline.runChatCompletion(normalized, ctx, signal)) {
      if (event.type === "text_delta" && event.delta) fullText += event.delta;
      yield event;
    }

    if (!Array.isArray(tools) || tools.length === 0 || !fullText) return;

    const call = parseToolCall?.(fullText, tools);
    if (!call) return;

    const callId = call.id || `call_ds_${Date.now()}_${round}`;
    yield evToolDone(ctx, callId, {
      id: callId,
      name: call.spec.name,
      kind: call.spec.kind,
      arguments: call.arguments,
      spec: call.spec,
    });

    // Single-hop by contract; the client owns tool execution.
    return;
  }
}
