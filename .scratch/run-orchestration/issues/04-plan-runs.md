# 04: Plan runs

Type: issue
Status: done
Slice: `run-orchestration#04`
Spec: `.scratch/run-orchestration/spec.md`
Created: 2026-10-18

## Parent

`run-orchestration`

## What to build

The operator starts a Plan for work that has no Spec or Issue yet by providing a slug; the harness spawns `execute <slug>`, and the pack reserves the next issue number and creates the branch with its final name. The new Spec card appears in the Specs lane and the Issue card appears in the Plan lane. The `plan-approval` pause renders inside that card, with links that open the new Spec and Issue files in the file viewer: answering `approve` keeps the same Run and moves the card through Implement, Review and Critic in the same worktree; answering `reject` deletes worktree and branch, discards the Run record and leaves no card in any lane. The `plan-dirty` pause (after the pack's own retry) offers `try-again` or `reject` inside the card without consuming correction budget. `spec-or-issue-exists` errors surface before spawn as card-level messages.

## Acceptance criteria

- [x] `POST /api/projects/:id/runs` with a slug (kind `plan`) spawns `execute <slug>` and records kind `plan` with the reserved ref once known.
- [x] The Spec card sits in Specs and the Issue card sits in Plan. The `plan-approval` pause is inside the Issue card and shows Spec and Issue paths that open in the file viewer; `approve` moves the same card through Implement, Review and Critic, `reject` removes worktree/branch/record and no card remains in any lane.
- [x] The `plan-dirty` pause offers only `try-again`/`reject` and is surfaced without spending budget.
- [x] Starting a plan whose slug already has a Spec or Issue shows the pack's `spec-or-issue-exists` error without spawning.
- [x] Integration test drives a real `cli.py execute <slug>` with fixture plan/implement/review/critic commands through approval, and through rejection.

## Blocked by

- `run-orchestration#03`

## Comments
