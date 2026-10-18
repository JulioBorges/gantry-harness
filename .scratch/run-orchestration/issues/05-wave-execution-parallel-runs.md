# 05: Wave execution and parallel Runs

Type: issue
Status: ready-for-agent
Slice: `run-orchestration#05`
Spec: `.scratch/run-orchestration/spec.md`
Created: 2026-10-18

## Parent

`run-orchestration`

## What to build

Executing a wave reads `frontier` from the pack and enqueues one `execute` per Issue ref in that order, each with its own child, stdin/stdout, worktree and Run record. Several Runs advance concurrently, and each pause surfaces independently in the Run screen so no Run's answer can reach another Run's stdin. Cards with open blockers stay on the board without a worktree and become available once their blockers are done on the target. The Run screen lists every active, paused, interrupted and approved Run per card.

## Acceptance criteria

- [ ] `POST /api/projects/:id/waves/execute` enqueues one Run per ref in frontier order and returns the started Runs.
- [ ] Concurrent Runs keep fully isolated stdio and records: a pause answer for ref A is never written to ref B's child.
- [ ] The Run screen renders all Runs per card with independent pause interactions.
- [ ] A `frontierBlocked` card cannot start from the wave action and shows its open blockers.
- [ ] Integration test runs two independent Issues in parallel real `cli.py` children and proves isolated pause/answer routing plus frontier ordering.

## Blocked by

- `run-orchestration#03`

## Comments
