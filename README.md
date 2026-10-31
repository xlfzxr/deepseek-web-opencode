# DeepSeek Web · OpenCode Bridge

A local OpenAI-compatible bridge that wraps **chat.deepseek.com** web sessions into
`/v1/chat/completions` + `/v1/responses` endpoints — tuned for the
[opencode](https://opencode.ai) CLI agent (and Codex, Cursor, or any OpenAI-compatible client).

Forked and repositioned from [db9cd2fgbj-hash/codex-deepseek-bridge](https://github.com/db9cd2fgbj-hash/codex-deepseek-bridge).
Useful tool-calling patches on top of upstream:

- **Tolerant DSML tool-call parser** — DeepSeek V3.2/V4 models sometimes emit internal
  `<｜DSML｜invoke…>` markup (double fullwidth pipes, parameters without prefix, missing wrapper).
  The parser now accepts all of these variants instead of only the canonical form.
- **Refreshed web-client headers** — `x-client-version`, `x-client-locale`, timezone offset,
  and a 6-field PoW payload.
- **Android/Termux support** — `src/android-preload.cjs` shim so `playwright-core` runs,
  adb helper scripts, and preload-wired npm scripts.
- **Modular architecture** — SSE writing and the whole orchestration flow are split out
  of `server.mjs` (see map below), with no external behavior change.

## Architecture

```ascii
[opencode / any OpenAI client]
        |  SSE / JSON  (http://127.0.0.1:8787)
        v
+----------------------------------------------------------+
| server.mjs  (HTTP router + OpenAI shape mapping)          |
|   src/transport/        SSE writer                        |
|   src/orchestration/    errors · events · session-store   |
|                         auth-manager · pipeline · tool-loop|
|   src/deepseek-web-client.mjs  (PoW, headers, adapter)    |
+----------------------------------------------------------+
        |  CDP + web API
        v
   [DeepSeek Web chat.deepseek.com]
```

Rule: **transport never calls the adapter directly** — only orchestration does.

## Quick start

```bash
# 1. login (opens Chrome via CDP, needs adb forward on Android)
npm run login

# 2. start the bridge (port 8787)
npm start

# 3. point opencode at it (~/.config/opencode/opencode.jsonc)
```

```jsonc
{
  "provider": {
    "deepseek-web": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepSeek Web (bridge)",
      "options": { "baseURL": "http://127.0.0.1:8787/v1" },
      "models": {
        "deepseek-chat": { "name": "DeepSeek Web Chat" },
        "deepseek-web/deepseek-reasoner": { "name": "DeepSeek Web Reasoner" }
      }
    }
  }
}
```

Then: `opencode run -m deepseek-web/deepseek-chat "ping"` → expect `PONG`-style reply.

### Example subagent for opencode

See [`examples/ds-executor.md`](./examples/ds-executor.md) — an atomic executor agent
(`mode: subagent`, step-capped, destructive bash denied) that DeepSeek Web can drive.

### Example agent contract

[`AGENTS.md`](./AGENTS.md) is the work contract used to let the model itself perform
incremental refactors safely (single-task discipline, verification steps, C4 rules).

## Troubleshooting (Termux / Android)

| Symptom | Fix |
|---|---|
| `Error: Unsupported platform: android` | run with `node --require ./src/android-preload.cjs src/server.mjs` (npm scripts already do) |
| `EADDRINUSE 8787` | kill the old bridge process first (`pkill -f src/server.mjs`) |
| login never starts | `adb connect <tablet>:<port>` then `adb forward tcp:9223 localabstract:chrome_devtools_remote` |
| empty completion (`0 字符`) | upstream returned nothing; retry, or use `deepseek-reasoner` |

## Scope & notes

- This is a local bridge over the DeepSeek **web** session — not the official DeepSeek API.
- Tool calling relies on prompt-driven `<tool_call>` / DSML output parsed by the gateway;
  stability differs from native function-calling models.
- Non-commercial license inherited from upstream — see [LICENSE](./LICENSE) and the
  original README preserved in [`UPSTREAM_README.md`](./UPSTREAM_README.md).
