# 03: Run supervisor and Issue execution

Type: issue
Status: ready-for-agent
Slice: `run-orchestration#03`
Spec: `.scratch/run-orchestration/spec.md`
Created: 2026-10-18

## Parent

`run-orchestration`

## What to build

Selecting an Issue card's run action spawns one `execute <ref>` child against the pinned pack, owned by a server-side run supervisor keyed by `(projectId, ref)`. The supervisor parses each stdout line as JSON, persists a harness-side Run record (ref, kind, child handle, branch, worktree, paused reason and choices, terminal event) in the state store, and renders every `pause` event — including `corrections-exhausted` — inside that Issue's card. The emitted choices are written back to that child's stdin as a single line. While the Run is in progress the card leaves the Issues lane and sits in Plan, Implement, Review or Critic, matching the role column (Integrate counts as Critic). The card offers follow-agent for that Run. `worktree`, `stopped` and `ready-for-approval` events and `error` payloads update the record and that overlay. Stopping at exhausted budget does not label the card ready to agent. A non-JSON line, an exit with an unanswered pause, or a nonzero exit without a terminal event surfaces as a failed/interrupted Run rather than vanishing. No new lane is added for paused, interrupted or awaiting-approval.

## Acceptance criteria

- [ ] `POST /api/projects/:id/runs` with an Issue ref spawns `execute` and emits the `worktree` event into the Run record and over WS.
- [ ] `POST /api/projects/:id/runs/:ref/answer` writes the chosen word to the child's stdin only while a pause is outstanding, and only offers the emitted `choices`.
- [ ] `corrections-exhausted` pause offers continue/stop; stop leaves the Run interrupted with worktree and branch and the card does not return to ready to agent.
- [ ] An `open-blocker` or `branch-exists` error surfaces on the card without a crash and without a worktree.
- [ ] While the child runs, the Issue card sits in the Plan, Implement, Review or Critic lane for the current role, follow-agent opens that Run, and pause choices render inside the card. Terminal events (`stopped`, `ready-for-approval`) and unexpected child exits produce the correct lane and phase label, and persisted records. Stopping does not label the card ready to agent and does not add a lane.
- [ ] Integration test runs a real `cli.py execute` in a temp repo with executable fixture role commands through pause, answer, and `ready-for-approval`.

## Blocked by

- `run-orchestration#02`

## Comments
