# 06: Resume, discard and restart reattach

**What to build:** An interrupted Run (stopped, or its child lost to a harness restart) can be resumed or discarded from its card. `resume <ref>` continues in the same worktree — re-opening the pause when the record's granted budget is spent, continuing from the last incomplete role otherwise, and short-circuiting to `ready-for-approval` without calling a role when the record is already finished. `discard <ref>` removes worktree and local branch: a plan-born Issue that never reached the target leaves no card, while an Issue already on the target returns to ready to agent. On server start and project open, the harness scans the pack's run records under `.git/gantry-cli/` and verifies branch/worktree existence, adopting interrupted Runs into its registry and re-reading done state from the target.

**Blocked by:** 03 — Run supervisor and Issue execution

**Status:** ready-for-agent

- [ ] `POST /api/projects/:id/runs/:ref/resume` continues an interrupted Run in the same worktree; a zero-budget record re-opens its pause without invoking a role.
- [ ] `POST /api/projects/:id/runs/:ref/discard` removes worktree and branch; plan-born refs leave no card, target-tracked refs return to ready to agent.
- [ ] After a server restart, pack run records (phases `plan`, `plan-approval`, `implement`, `checks`, `review`, `critic`, `ready`) reappear as adoptable Runs matched by Issue branch name and verified worktree.
- [ ] Done state is always re-read from the target, never from stale harness records.
- [ ] Integration test kills and restarts the harness server mid-Run and proves reattach, resume and discard against real `cli.py` records.
