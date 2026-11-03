# DeepSeek Web · OpenCode Bridge

A local OpenAI-compatible bridge that wraps **chat.deepseek.com** web sessions into
`/v1/chat/completions` + `/v1/responses` endpoints — tuned for the
[opencode](https://opencode.ai) CLI agent (and Codex, Cursor, or any OpenAI-compatible client).

Forked and repositioned from [db9cd2fgbj-hash/codex-deepseek-bridge](https://github.com/db9cd2fgbj-hash/codex-deepseek-bridge).
Useful tool-calling patches on top of upstream:

- **Tolerant DSML tool-call parser** — DeepSeek V3.2/V4 models sometimes emit internal
  `<｜DSML｜invoke…>` markup (double fullwidth pipes, parameters without prefix, missing wrapper).
  The parser accepts these variants instead of only the canonical form.
- **Header layer for WAF/fingerprint drift** — one coherent fingerprint derived from the
  login UA (client hints, same-origin `Origin`/`Referer`, `sec-fetch-*`, device id, fresh
  `x-hif-*` risk tokens), plus an importer for an exact browser capture.
- **Hardened SSE + local CORS** — eager flush, no-buffer headers, heartbeats, disconnect
  cancellation, and preflight support for browser clients.
- **Android/Termux support** — a Playwright preload shim, adb helper, and workspace scripts.
- **npm-workspaces monorepo** — runnable API app separated from orchestration, protocol,
  and DeepSeek Web provider packages.

## Monorepo layout

```text
apps/
  api/                  HTTP server, config, login and utility scripts
    src/server.mjs      HTTP bootstrap and route wiring
    src/runtime.mjs     application-service composition
    src/handlers/       system, Chat Completions, Responses and error handlers
  web/                  Static dashboard assets served by the API app
packages/
  core/                 orchestration, normalization, sessions and tool flow
  protocol/             DSML parsing and OpenAI request/response shapes
  transport/            reusable HTTP, CORS, router, SSE and OpenAI serializers
  deepseek-web/         authentication, provider client, PoW and upstream headers
```

The workspaces are named `@deepseek-web-opencode/api`, `@deepseek-web-opencode/web`,
`@deepseek-web-opencode/core`, `@deepseek-web-opencode/protocol`,
`@deepseek-web-opencode/transport`, and `@deepseek-web-opencode/deepseek-web`.

### Package boundaries

| Workspace | Owns | Depends on |
|---|---|---|
| `apps/api` | HTTP bootstrap, routes, runtime config, and login entrypoint | core, transport, provider, web assets |
| `apps/web` | Static dashboard assets | None; the API serves these files |
| `packages/core` | auth/session lifecycle, request normalization, pipeline and tool loop | protocol, provider |
| `packages/protocol` | DSML parsing and OpenAI shape mapping | Node.js only |
| `packages/transport` | HTTP helpers, CORS, routing, SSE and OpenAI serialization | protocol |
| `packages/deepseek-web` | DeepSeek Web auth/client, PoW, fingerprints and risk headers | `playwright-core` |

Dependency direction is one-way: API -> core -> provider; API also wires transport and web,
while core and transport depend on protocol. API serves the static files exported by `apps/web`;
web and provider do not depend on the API or orchestration. Each workspace exposes its public
modules through `package.json` exports, while the root package owns common npm commands.

## Header layer (fingerprint, same-origin, SSE)

The bridge is not a browser, but chat.deepseek.com's WAF expects one. Detection is about
**contradictions**, not single headers, so
`packages/deepseek-web/src/headers/upstream.mjs` is the only place that builds a request:

| Piece | Where | What it guarantees |
|---|---|---|
| Fingerprint | `packages/deepseek-web/src/headers/fingerprint.mjs` | `user-agent`, `sec-ch-ua*`, `sec-fetch-*`, `accept-language`, `x-client-*` derive from one UA + locale + timezone |
| Same-origin | `packages/deepseek-web/src/headers/fingerprint.mjs` | `Origin: https://chat.deepseek.com`, `Referer: …/`, `sec-fetch-site: same-origin`; a captured foreign origin is dropped |
| Identity | `packages/deepseek-web/src/headers/upstream.mjs` | stable `x-device-id` (persisted), `x-client-bundle-id`, `x-device-model` |
| Risk tokens | `packages/deepseek-web/src/headers/risk.mjs` | fresh `x-hif-leim` / `x-hif-dliq` (~10 min TTL, single-flight, soft failure) |
| PoW | `packages/deepseek-web/src/deepseek-web-client.mjs` | `x-ds-pow-response` only on `/chat/completion` |

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
# 1. Capture one request from a logged-in tab (Android/Termux utility)
npm run capture:browser

# 2. Sanitize and save it to .deepseek-auth/fingerprint.json
npm run fingerprint:capture -- /path/to/ds-capture2.json

# 3. Restart the bridge and re-check
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

`openSse()` in `packages/transport/src/sse-writer.mjs` sends
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
| `DEEPSEEK_AUTH_PATH` | `.deepseek-auth/credentials.json` | saved login credentials |
| `DEEPSEEK_AUTH_DIR` | `.deepseek-auth` | provider fingerprint/device data directory |
| `DEEPSEEK_BROWSER_PROFILE` | `.deepseek-browser-profile` | persistent Chrome/Edge profile |
| `DEEPSEEK_CDP_PORT` | `9222` | browser remote-debugging port |
| `DEEPSEEK_LOGIN_TIMEOUT_MS` | `300000` | maximum time to capture login credentials |
| `DEEPSEEK_BROWSER` | auto-detected | explicit Chrome/Edge executable path |
| `DEEPSEEK_FINGERPRINT_PATH` | `.deepseek-auth/fingerprint.json` | exact capture to replay |
| `DEEPSEEK_FINGERPRINT_JSON` | – | inline capture JSON (same shape as the file) |
| `DEEPSEEK_FINGERPRINT_UA` | login UA | override the UA used for derivation |
| `DEEPSEEK_LOCALE` | `en-US` | drives `accept-language` + `x-client-locale` |
| `DEEPSEEK_TZ_OFFSET` | system | seconds east of UTC for `x-client-timezone-offset` |
| `DEEPSEEK_CLIENT_VERSION` | `2.7.0` | `x-client-version` |
| `DEEPSEEK_DEVICE_ID` | persisted | pin `x-device-id` (else generated once) |
| `DEEPSEEK_RISK_HEADERS` | `1` | set `0` to skip `x-hif-*` fetches |
| `DEEPSEEK_RISK_TTL_MS` / `_RETRY_MS` / `_TIMEOUT_MS` | `600000` / `60000` / `4000` | risk token cache tuning |

Relative file paths are resolved from the repository root, independent of the workspace
that runs the command.

## Quick start

Requires Node.js 18+, npm, and Chrome/Edge. On Android/Termux, make sure adb and Chrome
remote debugging are available before login.

```bash
# 1. Install workspace dependencies
npm install

# 2. Login (opens Chrome via CDP; the adb preflight runs automatically)
npm run login

# 3. Start the bridge (port 8787)
npm start
```

Point opencode at it (`~/.config/opencode/opencode.jsonc`):

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

Then: `opencode run -m deepseek-web/deepseek-chat "ping"` → expect a `PONG`-style reply.

### Example subagent for opencode

See [`examples/ds-executor.md`](./examples/ds-executor.md) — an atomic executor agent
(`mode: subagent`, step-capped, destructive bash denied) that DeepSeek Web can drive.

### Monorepo development

`AGENTS.md` describes workspace responsibilities and dependency boundaries. Run root
commands (`npm start`, `npm run login`, or `npm run fingerprint:capture`) from the
repository root; individual workspaces can also be selected with `npm --workspace=<name>`.

## Troubleshooting (Termux / Android)

| Symptom | Fix |
|---|---|
| `Error: Unsupported platform: android` | use `npm start` / `npm run login`; they preload `packages/deepseek-web/src/android-preload.cjs` |
| `EADDRINUSE 8787` | stop the old bridge process first (`pkill -f 'src/server.mjs'`) |
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
