# Changelog

## Unreleased

- Add manual `npm run test:live` to verify the real DeepSeek session and catch upstream drift.
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
