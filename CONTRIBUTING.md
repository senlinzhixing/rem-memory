# Contributing to rem

Thanks for taking a look. This is an early-stage project; small, focused PRs are
the easiest to review.

## Development

```bash
pnpm install
pnpm build       # lib/index.js + lib/client.js
pnpm typecheck
pnpm verify      # offline checks, no DSH host required
```

`pnpm verify` runs two scripts:

- `verify.mjs` — loads the client bundle in a fake module loader and
  server-renders the sidebar panel.
- `verify-host.mjs` — loads the host bundle with a stubbed `@deepseek-ai/dsh-tools`
  and exercises segmentation, C1 cleaning, narrative, extraction, fidelity,
  recall, review, and sleep.

## Ground rules

- Keep the plugin working when `storageDomain` is unavailable (memory fallback).
- Every LLM call that expects JSON must go through `completeJson`; do not add a
  new direct `JSON.parse` path.
- New tools need a `verify-host.mjs` assertion and a README entry.
- Do not log card bodies, API keys, or absolute paths.
- Bump `version` before packing; installs key on the version number.

## Reporting bugs

Please include:

- DSH version (`dsh --version`), Node version, OS
- what you expected vs what happened
- any error text from the panel header (it reports the failing stage)
