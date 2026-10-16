# Status

Last updated: 2026-10-16

## Complete

- CLI (`swai review|generate|explain|commit-msg|plugins|price`) on a plugin
  kernel, with the built-in commands written as plugins.
- Two providers on one Chat Completions implementation: `openai` (hosted) and
  `compat` (any OpenAI-compatible server such as Ollama, vLLM or LM Studio).
- Stable exit codes 0 to 8, token and USD budgets, all-or-nothing patch apply.
- 324 tests across 14 files, with coverage floors enforced in
  `vitest.config.ts` (`npm run numbers` prints the current figures).
- Paid API emulation: no test or CI step calls a hosted model. The `compat`
  provider is exercised with the real OpenAI SDK over loopback HTTP against
  `tests/mock-openai/server.mjs`, both in-process
  (`tests/integration-compat.test.ts`) and as a separate process
  (`npm run smoke:compat`). The offline demo uses an out-of-tree stub provider
  plugin.
- CI: Linux, macOS and Windows on Node 20, 22 and 24, each running typecheck,
  tests with coverage, build, demo and the compat smoke check. An install check
  job follows the README install steps (clone, `npm pack`, global install of
  the tarball) and runs `swai` from an empty directory.

## In progress

- Nothing.

## Not started

- Publishing to npm. The release workflow is configured but skips without an
  `NPM_TOKEN`, and publishing is the owner's decision.
- ESLint and Prettier. Neither is configured, and adopting Prettier would
  reformat most of the tree. `tsc --noEmit` under `strict` is the only static
  check.
- A packaged GitHub Action with SARIF output.
- Repository context retrieval for reviews.

## Limitations

- No real model server (Ollama, vLLM, LM Studio) or hosted API is run in CI.
  The mock server proves the wire format, streaming, usage accounting and
  error handling, not review quality. Its token counts are an estimate.
- `npm install -g github:CGainsWorks/sw-ai-developer-cli` does not work,
  as npm does not build a git dependency for a global install. Install
  from a clone as the README describes.
- Retries are the OpenAI SDK's defaults (two retries with backoff on
  connection failures, 408, 409, 429 and 5xx). The CLI has no retry policy of
  its own.
