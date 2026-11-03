# Repository guide

This repository is an npm-workspaces monorepo for the DeepSeek Web OpenCode bridge.

## Workspace map

- `apps/api/` — HTTP bootstrap (`src/server.mjs`), runtime composition, route handlers,
  runtime configuration, login entrypoint, and Android helper scripts.
- `apps/web/` — static dashboard assets. The API serves this workspace's public directory.
- `packages/transport/` — HTTP helpers, CORS, routing, SSE framing, and OpenAI serialization.
- `packages/core/` — request normalization, auth/session orchestration, completion pipeline,
  and tool-call flow.
- `packages/protocol/` — dependency-free DSML parsing and OpenAI request/response shaping.
- `packages/deepseek-web/` — DeepSeek Web authentication/client, PoW, fingerprints, and
  upstream headers. Credentials and browser profile remain in the repository-root
  `.deepseek-auth/` and `.deepseek-browser-profile/` directories.

Run npm commands from the repository root. Root scripts forward to the appropriate
workspace. Package dependencies should be declared by the workspace that imports them;
use explicit `exports` in each package instead of reaching into another package's `src/`.

## Dependency boundaries

```text
apps/api ─────> packages/core ─────> packages/deepseek-web
   ├──────────> packages/transport ─────> packages/protocol
   └──────────> apps/web (static assets)
packages/core ──────────────────────────> packages/protocol
```

- The transport package owns HTTP helpers, routing, CORS, SSE and OpenAI JSON/SSE serialization.
- The API app composes handlers and transport, and serves web assets without a reverse dependency.
- Core owns business flow and must not import API or transport modules.
- The DeepSeek provider owns upstream calls and header construction; it must not import
  API or core modules.
- Protocol utilities stay dependency-free.
- Keep existing public endpoints, JSON shapes, SSE event names, and CLI commands stable
  unless a task explicitly requests a behavior change.

## Development notes

- Use ESM for JavaScript modules and keep workspace-relative runtime data rooted at the
  repository root.
- Do not commit `.deepseek-auth/`, `.deepseek-browser-profile/`, `.env` files, or generated
  captures/credentials.
- The automated test suite and its scripts were removed intentionally at the user's
  request. Do not restore or add tests unless the user asks for them. When changing runtime
  behavior, use syntax checks and manual endpoint verification during development.
- Avoid changing the embedded PoW WASM payload unless a task specifically requires it.
