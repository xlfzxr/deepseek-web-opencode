# DSML → OpenCode mapping

The bridge treats DSML as a prompt-level text contract, not a native function-calling API.
A parsed call is normalized into an in-memory `ToolCallIR`, then mapped against the tool
schemas supplied by the client before it is serialized as Chat Completions or Responses
`tool_calls`.

## Current flow

1. `packages/protocol/src/openai-shape.mjs` renders a versioned DSML prompt and hashes the
   version plus exact rendered text with SHA-256.
2. `packages/protocol/src/dsml-stream-parser.mjs` incrementally separates text from complete
   invoke blocks across chunks; incomplete blocks are preserved as text at stream end.
3. `packages/protocol/src/dsml.mjs` accepts ASCII/fullwidth pipes and optional DSML wrappers,
   parses multiple invokes, and retains the raw model output in each IR.
4. `packages/core/src/orchestration/mapping-registry.mjs` resolves exact names, known aliases,
   then a conservative unique fuzzy match.
5. `nested-builder.mjs` rebuilds dotted/bracketed paths; `coercer.mjs` uses the request's
   parameter schema to convert string values to numbers, booleans, objects, or arrays.
6. `schema-validator.mjs` validates mapped arguments with JSON Schema; invalid or malformed
   tool attempts get at most two repair prompts before falling back to assistant text.
7. The API emits only schema-valid calls through the OpenAI-compatible response shapes.

```js
{
  name: "read",
  params: { filePath: "README.md", offset: 12 },
  raw: "<｜DSML｜invoke ...>",
  confidence: 0.98,
  source: "dsml"
}
```

`raw` is retained in memory for repair and is written to a private, git-ignored JSONL trace
under `.deepseek-tool-traces/` by default. Set `DEEPSEEK_TOOL_TRACE=0` to disable raw-output
persistence; `npm run replay -- <request_id>` reparses and revalidates a stored trace.

## Tool name aliases

Exact names and `wireName`s always win before alias matching.

| Canonical tool | Accepted aliases |
|---|---|
| `bash` | `run`, `shell`, `run_command`, `execute`, `terminal` |
| `read` | `read_file`, `file_read` |
| `edit` | `edit_file`, `file_edit` |
| `write` | `write_file`, `file_write` |
| `glob` | `find_files`, `file_glob` |
| `grep` | `ripgrep`, `rg`, `search` |
| `webfetch` | `web_fetch`, `fetch_url` |
| `todowrite` | `todo_write` |
| `todoread` | `todo_read` |
| `task` | `subtask` |

Fuzzy matching uses normalized Levenshtein similarity. A candidate must score at least
`0.74` and beat the runner-up by at least `0.08`; ambiguous names remain unresolved.

## Parameter aliases

Alias targets are applied only when the target exists in the client-provided schema. Exact
schema keys and snake_case/camelCase-equivalent keys take precedence.

| Tool | Common aliases |
|---|---|
| `bash` | `cmd` / `script` → `command`; `cwd` / `working_directory` → `workdir`; `timeout_ms` → `timeout` |
| `read` | `path` / `file` → `filePath`; `start_line` → `offset`; `num_lines` → `limit` |
| `edit` | `path` / `file` → `filePath`; `old` / `old_text` → `oldString`; `new` / `new_text` → `newString` |
| `write` | `path` / `file` → `filePath`; `text` / `body` → `content` |
| `glob` | `glob` → `pattern`; `root` → `path` |
| `grep` | `query` / `search` / `regex` → `pattern`; `root` → `path`; `glob` → `include` |
| `webfetch` | `href` / `uri` → `url` |
| `todowrite` | `items` / `todo_list` → `todos` |

Nested paths such as `todos.0.content` and `todos[0].content` are reconstructed according
to the supplied array/item schema. Keys that could mutate object prototypes are discarded.

## Coercion and current limitations

- `string="false"` parameters are JSON-decoded by the parser.
- String values are converted according to schema types: `integer`, `number`, `boolean`,
  `object`, and `array`.
- Object and array values can also be supplied as JSON strings.
- Values that cannot be coerced are preserved so JSON Schema validation can report them.
- Validation currently uses the supplied tool schema and does not execute tools. Invalid
  attempts are retried at most twice; after that the last model response is returned as text.
- Private local trace/replay is implemented. Per-tool success-rate alerting and provider
  adapters remain later roadmap phases. Clients should still treat tool calls as untrusted
  input even after schema validation.
- Few-shot examples in the prompt are illustrative prompt material, **not** real-output
  fixtures. Real fixtures must be captured from DeepSeek Web and reviewed/redacted before use.

See [`prompts/dsml-spec.md`](../prompts/dsml-spec.md) for the prompt contract and
[`roadmap.md`](../roadmap.md) for the remaining phases.
