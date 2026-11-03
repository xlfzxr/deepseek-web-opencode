import { readConfig } from "../src/config.mjs";
import { createToolTraceStore } from "../src/tool-trace-store.mjs";
import { parseToolCallsFromText } from "@deepseek-web-opencode/core/orchestration/tool-parser";
import { validateToolCallAgainstSchema } from "@deepseek-web-opencode/core/orchestration/schema-validator";

const requestId = process.argv[2];
if (!requestId) {
  console.error("Usage: npm run replay -- <request_id>");
  process.exitCode = 1;
} else {
  const config = readConfig();
  const traceStore = createToolTraceStore({ ...config.toolTrace, enabled: true });
  const attempts = await traceStore.read(requestId);
  if (!attempts.length) {
    console.error(`No local DSML trace found for request: ${requestId}`);
    process.exitCode = 1;
  } else {
    for (const attempt of attempts) {
      const calls = parseToolCallsFromText(attempt.rawOutput, attempt.tools || []);
      const results = calls.map((call) => validateToolCallAgainstSchema(call, attempt.tools || []));
      console.log(
        JSON.stringify(
          {
            requestId: attempt.requestId,
            attempt: attempt.attempt,
            recordedAt: attempt.recordedAt,
            promptVersion: attempt.promptVersion,
            promptHash: attempt.promptHash,
            recordedOutcome: attempt.outcome,
            recordedToolCalls: (attempt.calls || []).map((call) => call.finalToolCall).filter(Boolean),
            replay: calls.map((call, index) => ({
              name: call.spec.name,
              mapping: call.mapping,
              arguments: call.arguments,
              valid: results[index].valid,
              errors: results[index].errors,
            })),
          },
          null,
          2,
        ),
      );
    }
  }
}
