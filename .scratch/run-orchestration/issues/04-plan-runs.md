# 04: Plan runs

**What to build:** The operator starts a Plan for work that has no Spec or Issue yet by providing a slug; the harness spawns `execute <slug>`, and the pack reserves the next issue number and creates the branch with its final name. The `plan-approval` pause renders links to the new Spec and Issue files in the file viewer: answering `approve` continues the same Run through implement, review and critic in the same worktree; answering `reject` deletes worktree and branch, discards the Run record and leaves no card. The `plan-dirty` pause (after the pack's own retry) offers `try-again` or `reject` without consuming correction budget. `spec-or-issue-exists` errors surface before spawn as card-level messages.

**Blocked by:** 03 — Run supervisor and Issue execution

**Status:** ready-for-agent

- [ ] `POST /api/projects/:id/runs` with a slug (kind `plan`) spawns `execute <slug>` and records kind `plan` with the reserved ref once known.
- [ ] The `plan-approval` pause shows Spec and Issue paths that open in the file viewer; `approve` continues the Run, `reject` removes worktree/branch/record and no card remains.
- [ ] The `plan-dirty` pause offers only `try-again`/`reject` and is surfaced without spending budget.
- [ ] Starting a plan whose slug already has a Spec or Issue shows the pack's `spec-or-issue-exists` error without spawning.
- [ ] Integration test drives a real `cli.py execute <slug>` with fixture plan/implement/review/critic commands through approval, and through rejection.
