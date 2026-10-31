# DeepSeek Web · OpenCode Bridge

A local OpenAI-compatible bridge that wraps **chat.deepseek.com** web sessions into
`/v1/chat/completions` + `/v1/responses` endpoints — tuned for the
[opencode](https://opencode.ai) CLI agent (and Codex, Cursor, or any OpenAI-compatible client).

Forked and repositioned from [db9cd2fgbj-hash/codex-deepseek-bridge](https://github.com/db9cd2fgbj-hash/codex-deepseek-bridge).
Useful tool-calling patches on top of upstream:

- **Tolerant DSML tool-call parser** — DeepSeek V3.2/V4 models sometimes emit internal
  `<｜DSML｜invoke…>` markup (double fullwidth pipes, parameters without prefix, missing wrapper).
  The parser now accepts all of these variants instead of only the canonical form.
- **Header layer for WAF/fingerprint drift** — one coherent fingerprint derived from the
  login UA (client hints, same-origin `Origin`/`Referer`, `sec-fetch-*`, device id, fresh
  `x-hif-*` risk tokens), plus an importer for an exact browser capture.
- **Hardened SSE + local CORS** — eager flush, no-buffer headers, heartbeats, disconnect
  cancellation, preflight support for browser clients.
- **Android/Termux support** — `src/android-preload.cjs` shim so `playwright-core` runs,
  adb helper scripts, and preload-wired npm scripts.
- **Modular architecture** — SSE writing and the whole orchestration flow are split out
  of `server.mjs` (see map below), with no external behavior change.

## Architecture

```ascii
[opencode / any OpenAI client]
        |  SSE / JSON  (http://127.0.0.1:8787)
        v
+-----------------------------------------------------------+
| src/server.mjs  (composition root: bootstrap + routes)     |
|   src/config.mjs         env -> injected config            |
|   src/transport/         http · router · cors · sse-writer  |
|                          openai-sse · openai-json           |
|   src/orchestration/     events · errors · session-store    |
|                          auth-manager · pipeline · tool-loop|
|                          request-normalizer · tool-call-    |
|                          registry · tool-parser ·           |
|                          provider-client · fingerprint-     |
|                          service                            |
|   src/headers/           fingerprint · upstream · risk      |
|   src/dsml.mjs           DSML/XML parser (shared leaf)      |
|   src/openai-shape.mjs   OpenAI mapping (shared leaf)       |
|   src/deepseek-web-client.mjs  (PoW, payload, adapter)      |
+-----------------------------------------------------------+
        |  CDP + web API
        v
   [DeepSeek Web chat.deepseek.com]
```

### Layers & contracts

| Layer | Owns | Must not |
|---|---|---|
| transport | HTTP parsing, routing, CORS, SSE/JSON serialization | import the adapter or header layer, read env |
| orchestration | auth/session lifecycle, pipelines, tool loop, normalization, error mapping | import transport, write HTTP directly |
| provider adapter | DeepSeek HTTP calls, PoW, stream parsing, upstream error metadata | routing, SSE transport, orchestration |
| header layer | fingerprint, same-origin, device identity, risk tokens | routing, business orchestration, arbitrary network calls |
| config | env parsing, host/port, CORS origins, model list | business logic |
| shared leaves | `dsml.mjs`, `openai-shape.mjs` | project imports |

Dependency direction is **one way**: transport -> orchestration -> adapter -> header ->
upstream. `src/server.mjs` is bootstrap + route wiring only. These rules are enforced
statically by `npm run test:arch` (import graph + `process.env` + server size), so a file
that bypasses a layer fails CI instead of silently growing a dependency.

## Header layer (fingerprint, same-origin, SSE)

The bridge is not a browser, but chat.deepseek.com's WAF expects one. Detection is about
**contradictions**, not single headers, so `src/headers/upstream.mjs` is the only place
that builds a request:

| Piece | Where | What it guarantees |
|---|---|---|
| Fingerprint | `src/headers/fingerprint.mjs` | `user-agent`, `sec-ch-ua*`, `sec-fetch-*`, `accept-language`, `x-client-*` are all derived from one UA + locale + timezone |
| Same-origin | `src/headers/fingerprint.mjs` | `Origin: https://chat.deepseek.com`, `Referer: …/`, `sec-fetch-site: same-origin`; a captured foreign origin is dropped |
| Identity | `src/headers/upstream.mjs` | stable `x-device-id` (persisted), `x-client-bundle-id`, `x-device-model` |
| Risk tokens | `src/headers/risk.mjs` | fresh `x-hif-leim` / `x-hif-dliq` (~10 min TTL, single-flight, soft failure) |
| PoW | `src/deepseek-web-client.mjs` | `x-ds-pow-response` only on `/chat/completion` |

Inspect exactly what will be sent (credentials redacted):

```bash
curl -s http://127.0.0.1:8787/api/fingerprint | jq '{browser, platform, source, warnings, risk, headers, sources}'
```

If `warnings` is non-empty, the fingerprint is internally inconsistent — fix that before
chasing anything else.

### Exact capture (when the WAF still disagrees)

Derived client hints are best-effort (GREASE brand rotation). To replay the real browser
verbatim, capture one `/api/v0/chat/completion` request and import it:

```bash
# 1. capture one request from a logged-in tab (see .capture-ds2.mjs)
node .capture-ds2.mjs            # writes $TMPDIR/opencode/ds-capture2.json

# 2. sanitize + save to .deepseek-auth/fingerprint.json
npm run fingerprint:capture -- /path/to/ds-capture2.json

# 3. restart the bridge and re-check
curl -s http://127.0.0.1:8787/api/fingerprint | jq '.source, .warnings'
```

The importer keeps fingerprint headers and drops credentials, hop-by-hop headers,
`content-type`, and expiring `x-hif-*` tokens. `source` becomes `capture+derived`, and
`sources` in `/api/fingerprint` tells you which layer produced each header
(`capture` / `fingerprint` / `credentials` / `endpoint` / `pow` / `risk` / `extra`).

### Local same-origin (browser clients)

Requests without an `Origin` header (opencode TUI, curl, Codex) are always accepted.
Browser origins are accepted when loopback (`http://localhost:*`, `http://127.0.0.1:*`),
or when listed explicitly. A rejected origin gets a JSON `403 origin_not_allowed`
instead of an opaque CORS failure, and preflight (`OPTIONS`) is answered with
`access-control-allow-*` + `access-control-allow-private-network` for Chrome PNA.

### SSE hardening

`openSse()` in `src/transport/sse-writer.mjs` sends
`text/event-stream` + `cache-control: no-cache, no-store, no-transform` +
`x-accel-buffering: no`, flushes headers immediately, sends a `retry:` hint on the UI
log stream, emits `: keep-alive` comments every 15s, and aborts the upstream fetch when
the client disconnects. `sseWrite`/`sseEvent`/`sseDone` are no-ops after `end`.

### Environment knobs

| Variable | Default | Purpose |
|---|---|---|
| `DEEPSEEK_BRIDGE_HOST` | `127.0.0.1` | listen address (`0.0.0.0` for containers) |
| `DEEPSEEK_BRIDGE_ALLOW_ORIGINS` | loopback only | comma list of allowed browser origins, or `*` |
| `DEEPSEEK_SSE_HEARTBEAT_MS` | `15000` | SSE keep-alive comment interval (`0` disables) |
| `DEEPSEEK_FINGERPRINT_PATH` | `.deepseek-auth/fingerprint.json` | exact capture to replay |
| `DEEPSEEK_FINGERPRINT_JSON` | – | inline capture JSON (same shape as the file) |
| `DEEPSEEK_FINGERPRINT_UA` | login UA | override the UA used for derivation |
| `DEEPSEEK_LOCALE` | `en-US` | drives `accept-language` + `x-client-locale` |
| `DEEPSEEK_TZ_OFFSET` | system | seconds east of UTC for `x-client-timezone-offset` |
| `DEEPSEEK_CLIENT_VERSION` | `2.7.0` | `x-client-version` |
| `DEEPSEEK_DEVICE_ID` | persisted | pin `x-device-id` (else generated once) |
| `DEEPSEEK_RISK_HEADERS` | `1` | set `0` to skip `x-hif-*` fetches |
| `DEEPSEEK_RISK_TTL_MS` / `_RETRY_MS` / `_TIMEOUT_MS` | `600000` / `60000` / `4000` | risk token cache tuning |

## Testing

```bash
npm test               # everything below
npm run smoke              # endpoints, auth-missing path, static serving
npm run test:dsml          # DSML/XML/JSON parser variants
npm run test:orchestration # normalization, error mapping, auth lifecycle, tool loop
npm run test:arch          # import-graph/layer gates (static, no execution)
npm run test:headers       # fingerprint, CORS/preflight, SSE framing, /api/fingerprint
npm run test:toolcall      # chat + responses tool-call flow via fetch stub
npm run test:live      # manual: real DeepSeek session (needs login + network)
```

Tests need no credentials and no network: the tool-call suite stubs `fetch` and solves
PoW locally, and the orchestration suite uses fake clients. `test:live` is the exception — it talks to chat.deepseek.com to detect
upstream drift, so it needs a valid login and is **not** run in CI. CI
(`.github/workflows/ci.yml`) runs `npm test` on every push.

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
| upstream `429` + HTML body | WAF/fingerprint mismatch: check `/api/fingerprint` → `warnings`, then import an exact capture (`npm run fingerprint:capture`) |
| browser client blocked by CORS | add its origin: `DEEPSEEK_BRIDGE_ALLOW_ORIGINS=https://app.example npm start` |
| SSE cuts off after ~60s idle | keep `DEEPSEEK_SSE_HEARTBEAT_MS` ≤ any proxy idle timeout, and check `x-accel-buffering: no` survives your proxy |

## Scope & notes

- This is a local bridge over the DeepSeek **web** session — not the official DeepSeek API.
- Tool calling relies on prompt-driven `<tool_call>` / DSML output parsed by the gateway;
  stability differs from native function-calling models.
- Non-commercial license inherited from upstream — see [LICENSE](./LICENSE) and the
  original README preserved in [`UPSTREAM_README.md`](./UPSTREAM_README.md).
