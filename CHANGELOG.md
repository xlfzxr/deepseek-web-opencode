# Changelog

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
