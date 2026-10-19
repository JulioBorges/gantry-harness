# 07: Approve, PR watching and merge-done

Type: issue
Status: ready-for-agent
Slice: `run-orchestration#07`
Spec: `.scratch/run-orchestration/spec.md`
Created: 2026-10-18

## Parent

`run-orchestration`

## What to build

A finished Run offers the approval action on its card, in the execution lane it already occupies. There is no approved-pending-merge lane. `approve <ref>` runs in the Run's worktree, creating the closing commit that marks the Issue and roadmap done when it does not yet exist, pushing, and opening the PR — or only opening the PR when the closing commit is already on the branch. The emitted `pull-request` event's URL is stored on the Run record and shown on the card. Until the target says done, the card stays out of the Done lane and is not labeled ready to agent. A watcher re-reads the target on board refresh and an interval: a merged PR moves the card to the Done lane and the harness removes the local worktree and branch, writing nothing more; a PR closed without merge ends the Run without done, keeps the card visible in Issues outside the ready-to-agent label, removes the local worktree, and lets reopening re-offer approval on that card. Approve errors (`worktree-dirty`, `remote-missing`, `push-failed`, `pull-request-failed`) surface on the card with the pack's code.

## Acceptance criteria

- [ ] `POST /api/projects/:id/runs/:ref/approve` runs `approve` in the worktree and stores the PR URL from the `pull-request` event on the record and card.
- [ ] With the closing commit already on the branch, approve only opens the PR (no duplicate close).
- [ ] Approve errors surface on the card with the pack's error code and leave the Run awaiting approval.
- [ ] After the Issue's closing commit is on the target, the card moves to the Done lane and local worktree/branch are removed; remote refs are never touched.
- [ ] A closed-unmerged PR leaves the card in the Issues lane, outside the ready-to-agent label and outside Done, with approval re-offered on reopen.
- [ ] Integration test drives a real `cli.py` Run to `ready-for-approval`, approves with a stubbed `gh`/remote, then flips done after the closing commit reaches the target.

## Blocked by

- `run-orchestration#03`

## Comments
