## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root). See `docs/agents/domain.md`.

## Cursor Cloud specific instructions

- Node.js 22.12+ and Bun are required. The environment install links `bun` into `/usr/local/bin` so login shells can find it.
- On boot, `start` serves the already built web app at http://127.0.0.1:7400 (`node dist/cli.js --port 7400`). Use that browser UI. `bun start` launches Electron and is not the cloud entry point.
- Checks from the repo root: `bun run typecheck`, `bun run test`, `bun run build`. The run-supervisor test that waits for the Review lane can miss its one-second UI wait when the full suite runs in parallel. It passes on its own: `bun x vitest run tests/run-supervisor.test.tsx -t "runs real cli.py execute through worktree"`.
