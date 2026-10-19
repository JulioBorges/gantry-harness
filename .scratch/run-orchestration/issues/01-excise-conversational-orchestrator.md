# 01: Excise the conversational orchestrator

Type: issue
Status: done
Slice: `run-orchestration#01`
Spec: `.scratch/run-orchestration/spec.md`
Created: 2026-10-18

## Parent

`run-orchestration`

## What to build

The harness no longer carries a model-driven orchestrator, so the pack CLI introduced in later tickets is its only execution path. Remove the coordinator chat, host-assisted command preparation (`/plan`, `/run`, `/setup` shortcuts), the TypeScript plan workflow (grilling rounds, spec synthesis and validation, draft-issue editing, plan-approval card), the TypeScript round engine (frontier computation, worktree creation, role dispatch and result-contract validation, correction-budget tracking, learner, cleanup authorization), subagent steering, worktree takeover, role-replacement recovery, lesson candidates, and the AI provider connection settings. Their HTTP endpoints and UI surfaces are gone, and `types.ts` drops the decision-card, run-lifecycle and provider types they fed. What stays working end to end: project registration and sidebar, workspace layout persistence, standalone terminal panes, the file viewer, terminal settings, and pairing/remote access. The conversation session is not part of the workspace. There is no conversation tab, no host connected to a conversation screen, and no `POST /api/projects/:id/chat`.

## Acceptance criteria

- [x] No HTTP endpoint or UI surface remains for coordinator chat, command preparation, plan workflow, run workflow, steering, takeover, recovery, lessons or cleanup.
- [x] Provider/AI connection settings and their stored configuration are removed from settings surfaces and state reads.
- [x] Project sidebar, terminal panes, file viewer, terminal settings and remote access still pass their existing observable behaviors (updated to compile without the deleted modules).
- [x] The conversation tab and "Main Workspace session" entry points are removed from primary navigation.
- [x] The conversation session and its host connection are absent. The terminal remains the agent surface.
- [x] Workspace areas are Quadro, Terminal and Files. "Acompanhar execução" is not a navigation entry.
- [x] `bun run typecheck` and the surviving test suite pass.

## Blocked by

- None (can start immediately)

## Comments

2026-10-19: Layout after the conversation removal is Quadro, Terminal and Files. The execution-tracking screen is not a separate area.
