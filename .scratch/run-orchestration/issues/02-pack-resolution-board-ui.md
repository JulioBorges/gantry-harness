# 02: Pack resolution, board read and board UI

Type: issue
Status: done
Slice: `run-orchestration#02`
Spec: `.scratch/run-orchestration/spec.md`
Created: 2026-10-18

## Parent

`run-orchestration`

## What to build

Opening a project that has the Gantry pack installed shows its Issues and Specs board, read deterministically through the pack's `board` command. Resolution prefers the repository-pinned copy (`<repo>/.agents/skills/gantry/scripts/cli.py` via `python3`) and falls back to a `gantry` executable on `PATH`; when neither resolves, the project shows no execution affordance. The board is a horizontal-scrolling Kanban. Lanes, left to right: Specs, Issues, Plan, Implement, Review, Critic, Done. Spec cards always sit in Specs and are non-executable. An Issue sits in Done when its status is done; in Plan, Implement, Review or Critic while a live Run overlay names that phase (Integrate counts as Critic); otherwise in Issues. The card's phase label is ready to agent, blocked (with open blockers) or done, from repository truth. Each Spec card opens its documentation. Each Issue card opens its Spec when one exists. A card in an execution lane can follow the running agent, and prompts, pauses and blockers render inside that card. The board is the primary surface and re-reads the repository on explicit refresh.

## Acceptance criteria

- [x] A repo with a pack copy resolves and executes `cli.py board` from that pinned path; a repo without it but with `gantry` on PATH falls back; a repo with neither disables run/plan/approve affordances with an explanatory state.
- [x] `GET /api/projects/:id/board` returns issues (ref, spec, number, title, status, path, frontierBlocked, openBlockers), specs (slug, path, executable) and frontier ordering from the pack output.
- [x] The board renders the lanes Specs, Issues, Plan, Implement, Review, Critic and Done in that order, with horizontal scroll. Spec cards are non-executable and stay in Specs. Issue cards show ready to agent, blocked (with visible open blockers) or done from board data. Done status places the card in Done; a live overlay places it in Plan, Implement, Review or Critic; every other Issue stays in Issues.
- [x] A Spec card opens its documentation. An Issue card opens its Spec. A card in an execution lane offers follow-agent, and an outstanding operator prompt renders inside the card.
- [x] Board refresh re-reads the repository rather than harness-side caches.
- [x] Integration test drives a temp git repo with a minimal pinned pack and proves all three resolution paths plus the blocked/done mapping.

## Blocked by

- `run-orchestration#01`

## Comments
