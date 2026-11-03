# Changelog

## Unreleased

- Reorganize the repository into npm workspaces: `apps/api`, `apps/web`, `packages/core`, `packages/protocol`, `packages/transport`, and `packages/deepseek-web`.
- Separate API bootstrap, runtime composition, and system/chat/responses handlers into focused modules.
- Extract HTTP and OpenAI transport helpers into the `packages/transport` workspace.
- Resolve auth, profile, fingerprint, and device paths from root configuration and inject them into the provider.
- Remove the built-in automated test scripts and test-only GitHub Actions workflow.
- Define a versioned DSML prompt contract with SHA-256 logging, tolerant multi-invoke parsing,
  canonical IR, OpenCode tool/parameter mapping, schema-guided coercion, and nested arguments.
- Emit multiple parsed invocations through Chat Completions and Responses JSON/SSE outputs;
  add incremental SSE parsing so ordinary text streams eagerly while tool calls remain buffered for validation.
- Add `prompts/dsml-spec.md`, `docs/mapping.md`, fixture-capture guidance, and the phased `roadmap.md`.
- Add Ajv-based tool-schema validation, a bounded two-retry DSML repair loop, and private
  local JSONL traces with an offline replay command. Real DeepSeek fixture collection, per-tool
  alerting, and provider adapters remain pending.
- Architecture hardening: `apps/api/src/server.mjs` is now bootstrap + route wiring only;
  prompt normalization, tool-call registry, JSON/SSE shaping and fingerprint inspection moved
  into orchestration/transport modules.
- Add `apps/api/src/config.mjs` as the single env reader; heartbeat, CORS and header options are
  injected instead of re-read inside layers.
- Adapter failures are typed (`packages/deepseek-web/src/upstream-error.mjs`: kind/status/retryable) and mapped in
  orchestration to stable codes (`rate_limited`, `waf_blocked`, `upstream_error`, ...).
- Auth lifecycle (login + cache invalidation) moved behind `auth-manager`; the composition
  root no longer imports `deepseek-auth.mjs`.
- Tool loop contract documented as single-hop (client-executed tools) with an explicit budget
  cap; added `tool-call-registry`, `request-normalizer`, `provider-client`,
  `fingerprint-service`, `packages/transport/src/openai-sse.mjs`, `packages/transport/src/openai-json.mjs`.
- Add `packages/deepseek-web/src/headers/` header layer: fingerprint derived from the login UA (client hints,
  same-origin Origin/Referer, sec-fetch, x-client-*), persisted `x-device-id`, and
  `x-hif-*` risk-token cache with TTL + single-flight + soft failure.
- Add `apps/api/scripts/fingerprint-from-capture.mjs` (`npm run fingerprint:capture`) to replay an
  exact sanitized browser capture; `GET /api/fingerprint` shows the resolved headers.
- Add local CORS policy with real `OPTIONS` preflight handling and JSON `403` for
  disallowed origins (`DEEPSEEK_BRIDGE_ALLOW_ORIGINS`).
- Harden SSE: `no-transform`, `x-accel-buffering: no`, eager header flush, `retry:` hint,
  heartbeats, write guards, and upstream cancellation on client disconnect.

## 0.2.0 — 2026-10-31

- Split DSML/XML tool-call parsing into `src/dsml.mjs`.
- Split OpenAI prompt/item mapping into `src/openai-shape.mjs`.
- Extract HTTP helpers and router into `src/transport/http.mjs` and `src/transport/router.mjs`.
- Wire `BridgeError` / `ErrorCode` into auth-manager and pipeline.
- Add test suite: `npm test` (smoke, DSML parser, tool-call e2e with stubbed upstream).
- Add GitHub Actions CI running `npm test`.
- Smoke now covers static serving and uses an ephemeral port.

## 0.1.0

- Initial opencode-oriented bridge: transport/orchestration refactor, repo reposition,
  example subagent, tolerant DSML parser, Android/Termux support.
