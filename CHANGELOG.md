# Changelog

## Unreleased

- Add manual `npm run test:live` to verify the real DeepSeek session and catch upstream drift.
- Architecture hardening (quality gate): `server.mjs` is now bootstrap + route wiring only;
  prompt normalization, tool-call registry, JSON/SSE shaping and fingerprint inspection moved
  into orchestration/transport modules.
- Add `src/config.mjs` as the single env reader; heartbeat, CORS and header options are
  injected instead of re-read inside layers.
- Adapter failures are typed (`src/upstream-error.mjs`: kind/status/retryable) and mapped in
  orchestration to stable codes (`rate_limited`, `waf_blocked`, `upstream_error`, ...).
- Auth lifecycle (login + cache invalidation) moved behind `auth-manager`; the composition
  root no longer imports `deepseek-auth.mjs`.
- Tool loop contract documented as single-hop (client-executed tools) with an explicit budget
  cap; added `tool-call-registry`, `request-normalizer`, `provider-client`,
  `fingerprint-service`, `transport/openai-sse.mjs`, `transport/openai-json.mjs`.
- Add `npm run test:arch` (import-graph gates) and `npm run test:orchestration`
  (normalization, error mapping, auth dedupe/failure, tool loop, fingerprint service).
- Add `src/headers/` header layer: fingerprint derived from the login UA (client hints,
  same-origin Origin/Referer, sec-fetch, x-client-*), persisted `x-device-id`, and
  `x-hif-*` risk-token cache with TTL + single-flight + soft failure.
- Add `scripts/fingerprint-from-capture.mjs` (`npm run fingerprint:capture`) to replay an
  exact sanitized browser capture; `GET /api/fingerprint` shows the resolved headers.
- Add local CORS policy with real `OPTIONS` preflight handling and JSON `403` for
  disallowed origins (`DEEPSEEK_BRIDGE_ALLOW_ORIGINS`).
- Harden SSE: `no-transform`, `x-accel-buffering: no`, eager header flush, `retry:` hint,
  heartbeats, write guards, and upstream cancellation on client disconnect.
- Add `npm run test:headers` covering fingerprint coherence, CORS, SSE framing, and the
  debug endpoint.

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
