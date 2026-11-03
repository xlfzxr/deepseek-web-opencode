# Real DeepSeek Web fixtures

Store only reviewed, verbatim model outputs captured while using the versioned DSML prompt.
Do not place hand-written examples here; those belong in `prompts/dsml-spec.md`.

For each capture, add a small JSON file with:

```json
{
  "model": "deepseek-web/deepseek-chat",
  "promptVersion": "dsml-prompt-v1",
  "capturedAt": "<ISO-8601 timestamp>",
  "toolSchema": [],
  "rawOutput": "<redacted verbatim DeepSeek output>"
}
```

Remove credentials and private user data without altering the DSML syntax being evaluated.
The fixture gate is intentionally empty until actual output is provided/captured.
