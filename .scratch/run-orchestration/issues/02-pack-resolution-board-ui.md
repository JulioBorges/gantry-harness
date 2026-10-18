# 02: Pack resolution, board read and board UI

**What to build:** Opening a project that has the Gantry pack installed shows its Issues and Specs board, read deterministically through the pack's `board` command. Resolution prefers the repository-pinned copy (`<repo>/.agents/skills/gantry/scripts/cli.py` via `python3`) and falls back to a `gantry` executable on `PATH`; when neither resolves, the project shows no execution affordance. Each Issue card displays ref, title, open blockers and a phase computed from repository truth: done when the Issue is done on the target, blocked while `frontierBlocked`, otherwise ready to agent. Spec cards render as non-executable support documents. The board is the primary surface and re-reads the repository on explicit refresh.

**Blocked by:** 01 — Excise the conversational orchestrator

**Status:** ready-for-agent

- [ ] A repo with a pack copy resolves and executes `cli.py board` from that pinned path; a repo without it but with `gantry` on PATH falls back; a repo with neither disables run/plan/approve affordances with an explanatory state.
- [ ] `GET /api/projects/:id/board` returns issues (ref, spec, number, title, status, path, frontierBlocked, openBlockers), specs (slug, path, executable) and frontier ordering from the pack output.
- [ ] Cards render ready to agent, blocked (with visible open blockers) or done purely from board data; Spec cards are visibly non-executable.
- [ ] Board refresh re-reads the repository rather than harness-side caches.
- [ ] Integration test drives a temp git repo with a minimal pinned pack and proves all three resolution paths plus the blocked/done mapping.
