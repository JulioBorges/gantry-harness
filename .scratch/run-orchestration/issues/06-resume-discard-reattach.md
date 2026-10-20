# 06: Resume, discard and restart reattach

Type: issue
Status: done
Slice: `run-orchestration#06`
Spec: `.scratch/run-orchestration/spec.md`
Created: 2026-10-18

## Parent

`run-orchestration`

## What to build

An interrupted Run (stopped, or its child lost to a harness restart) can be resumed or discarded from its card. The card stays out of the ready-to-agent label. On reattach it returns to the Plan, Implement, Review or Critic lane of the pack record's phase (`plan` and `plan-approval` → Plan, `implement` and `checks` → Implement, `review` → Review, `critic` → Critic, `ready` → the last execution lane with approval offered on the card, not a new column). `resume <ref>` continues in the same worktree — re-opening the pause inside the card when the record's granted budget is spent, continuing from the last incomplete role otherwise, and short-circuiting to `ready-for-approval` without calling a role when the record is already finished. `discard <ref>` removes worktree and local branch: a plan-born Issue that never reached the target leaves no card in any lane, while an Issue already on the target returns to the Issues lane as ready to agent. On server start and project open, the harness scans the pack's run records under `.git/gantry-cli/` and verifies branch/worktree existence, adopting interrupted Runs into its registry and re-reading done state from the target. Done on the target places the card in Done.

## Acceptance criteria

- [x] `POST /api/projects/:id/runs/:ref/resume` continues an interrupted Run in the same worktree; a zero-budget record re-opens its pause without invoking a role.
- [x] `POST /api/projects/:id/runs/:ref/discard` removes worktree and branch; plan-born refs leave no card in any lane, target-tracked refs return to the Issues lane as ready to agent.
- [x] After a server restart, pack run records reappear in Plan (`plan`, `plan-approval`), Implement (`implement`, `checks`), Review (`review`) or Critic (`critic`); `ready` stays out of Done until the target says done. Matching is by Issue branch name and verified worktree.
- [x] Done state is always re-read from the target, never from stale harness records.
- [x] Integration test kills and restarts the harness server mid-Run and proves reattach, resume and discard against real `cli.py` records.

## Blocked by

- `run-orchestration#03`

## Comments
