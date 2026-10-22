## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root). See `docs/agents/domain.md`.

## Cursor Cloud specific instructions

- Node.js 22.12+ and Bun are required. The environment install links `bun` into `/usr/local/bin` so login shells can find it.
- On boot, `start` serves the already built web app at http://127.0.0.1:7400 (`node dist/cli.js --port 7400`). Use that browser UI. `bun start` launches Electron and is not the cloud entry point.
- Checks from the repo root: `bun run typecheck`, `bun run test --maxWorkers=2`, `bun run build`. The pipeline also limits the test suite to two workers: unrestricted concurrency can exceed the UI/supervisor waits. For an isolated pipeline check: `bun x vitest run tests/run-supervisor.test.tsx -t "runs real cli.py execute through worktree"`.
