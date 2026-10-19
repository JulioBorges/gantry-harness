# 05: Wave execution and parallel Runs

Type: issue
Status: ready-for-agent
Slice: `run-orchestration#05`
Spec: `.scratch/run-orchestration/spec.md`
Created: 2026-10-18

## Parent

`run-orchestration`

## What to build

Executing a wave reads `frontier` from the pack and enqueues one `execute` per Issue ref in that order, each with its own child, stdin/stdout, worktree and Run record. Several Runs advance concurrently. Each Issue card moves on its own into Plan, Implement, Review or Critic, and each pause renders inside that card so no Run's answer can reach another Run's stdin. Cards with open blockers stay in the Issues lane, without a worktree, and become available once their blockers are done on the target. Following an agent opens only that card's Run.

## Acceptance criteria

- [ ] `POST /api/projects/:id/waves/execute` enqueues one Run per ref in frontier order and returns the started Runs.
- [ ] Concurrent Runs keep fully isolated stdio and records: a pause answer for ref A is never written to ref B's child.
- [ ] Each running card sits in its own execution lane and renders its pause inside the card; an answer on one card never writes to another Run.
- [ ] A `frontierBlocked` card stays in the Issues lane, cannot start from the wave action, and shows its open blockers.
- [ ] Integration test runs two independent Issues in parallel real `cli.py` children and proves isolated pause/answer routing plus frontier ordering.

## Blocked by

- `run-orchestration#03`

## Comments
