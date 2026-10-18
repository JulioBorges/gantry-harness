# 01: Excise the conversational orchestrator

**What to build:** The harness no longer carries a model-driven orchestrator, so the pack CLI introduced in later tickets is its only execution path. Remove the coordinator chat, host-assisted command preparation (`/plan`, `/run`, `/setup` shortcuts), the TypeScript plan workflow (grilling rounds, spec synthesis and validation, draft-issue editing, plan-approval card), the TypeScript round engine (frontier computation, worktree creation, role dispatch and result-contract validation, correction-budget tracking, learner, cleanup authorization), subagent steering, worktree takeover, role-replacement recovery, lesson candidates, and the AI provider connection settings. Their HTTP endpoints and UI surfaces are gone, and `types.ts` drops the decision-card, run-lifecycle and provider types they fed. What stays working end to end: project registration and sidebar, workspace layout persistence, standalone terminal panes, the file viewer, terminal settings, and pairing/remote access.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] No HTTP endpoint or UI surface remains for coordinator chat, command preparation, plan workflow, run workflow, steering, takeover, recovery, lessons or cleanup.
- [ ] Provider/AI connection settings and their stored configuration are removed from settings surfaces and state reads.
- [ ] Project sidebar, terminal panes, file viewer, terminal settings and remote access still pass their existing observable behaviors (updated to compile without the deleted modules).
- [ ] The conversation tab and "Main Workspace session" entry points are removed from primary navigation.
- [ ] `bun run typecheck` and the surviving test suite pass.
