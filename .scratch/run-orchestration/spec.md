# Spec: Run Orchestration via the `gantry` CLI (`run-orchestration`)

Type: spec
Status: approved
Map: `ROADMAP.md` (spec 01)
Created: 2026-10-18

Supersedes the orchestration model of `.scratch/gantry-harness/spec.md` for everything the PRD covers. The earlier spec remains the authority for desktop shell, project sidebar, terminal tabs, file viewer and settings; this spec replaces its conversational coordinator, TypeScript plan/round engines, subagent steering and role-replacement recovery with parent-process orchestration of the repository-pinned `gantry` command.

## Problem Statement

Running Gantry today means opening a coding agent, invoking a skill and driving the request through chat. The operator wants to load a repository that already has the pack installed, see its Issues and Specs on a board, and execute the flow with interaction only when a human answer is required.

The current `gantry-harness` reimplements the factory in TypeScript: its own grilling interview, spec synthesis, tracer-bullet slicing, plan critic, frontier computation, worktree management, role dispatch through a configured LLM provider, correction budget bookkeeping and cleanup flows. That implementation duplicates the pack's authority, drifts whenever the pack changes, and produces a conversation tab the operator finds confusing. The pack now ships a deterministic CLI (`gantry` with the `board`, `issues`, `specs`, `frontier`, `execute`, `approve`, `resume` and `discard` subcommands, backed by `cli.py` inside each repository's pinned copy of the skill pack). The harness has not been adapted to it, so the CLI's single-orchestrator contract and the harness's duplicated orchestrator compete.

## Solution

Make `gantry-harness` the orchestrator's parent process and the screen of the Run, per `docs/PRD-integration.md`. The pack's `gantry` command — resolved from the repository's pinned pack copy — is the sole authority for role order, verdicts, correction budget, blockers, roadmap closure and pull-request opening. The harness spawns it, reads one JSON object per line on stdout, renders every pause as an interaction, and writes the operator's answer back to that same process's stdin. The Issues and Specs board is read in parallel through deterministic commands, straight from the repository's files.

Concretely:

1. **Board from the pack CLI.** When a project has the pack installed, the board lists every Issue and Spec from `gantry board` (issues with `ref`, `spec`, `number`, `title`, `status`, `path`, `frontierBlocked`, `openBlockers`; specs with `slug`, `path`, `executable: false`; plus the `frontier` ordering). The board is a horizontal-scrolling Kanban with seven lanes, in this order: **Specs**, **Issues**, **Plan**, **Implement**, **Review**, **Critic**, **Done**. Spec cards always sit in Specs. An Issue sits in Done when its status is done on the target; in Plan, Implement, Review or Critic while a live Run overlay places it in that phase (the pack's Integrate column counts as Critic); otherwise in Issues, including ready to agent and blocked. The phase label on the card (ready to agent, blocked, done) comes from repository truth. Run-time lane placement exists only in the harness; the Issue and Spec files do not change when a Run starts, when setup fails, or when a plan is rejected.
2. **One `gantry execute` child per Run.** Executing an Issue card spawns `execute <slug>#<NN>`; executing a wave enqueues one Run per Issue in frontier order; starting a Plan spawns `execute <slug>` for work that has no Spec or Issue yet. Each Run gets its own Issue branch and worktree, and multiple Runs proceed in parallel when none depends on another. The harness stores its own local Run record (child handle, ref, branch, worktree, paused state, PR url) outside the pull request and outside the repository's tracked files.
3. **JSONL pause protocol.** While a child runs, the harness parses each stdout line as an event. `pause` events carry a `reason` and `choices`; the harness renders them and pipes the chosen word back on the child's stdin. Reasons surfaced to the operator: `plan-approval` (approve/reject), `corrections-exhausted` (continue/stop), `plan-dirty` (try-again/reject). `stopped`, `ready-for-approval`, `rejected`, `discarded`, `pull-request` and `error` payloads drive the Run record and card state.
4. **Approval and PR watching.** A finished Run (`ready-for-approval`) offers the approval action, which runs `gantry approve <ref>` in the same worktree — creating the closing commit when needed, pushing and opening the PR, then storing the returned URL. The harness then monitors approved cards that are not yet done: it re-reads the target branch to detect merge (card becomes done, worktree and local branch are removed, nothing else is written) or a closed-unmerged PR (Run ends without done, card stays visible outside ready to agent, local worktree leaves; reopening the PR repeats only the approval).
5. **Resume, discard and reattach.** An interrupted Run (`stopped`) keeps its worktree and branch and does not return to ready to agent. `resume <ref>` continues in the same worktree — re-opening the pause when budget is zero, continuing the last incomplete role otherwise. `discard <ref>` removes worktree and local branch: a card born from a plan that never reached the target disappears; a card already on the target returns to ready to agent. After a restart the harness finds each interrupted or in-flight Run again from the pack's own run records and branch names, and re-reads done state from the target.
6. **No binary reliance beyond the repo.** The harness locates `cli.py` inside the repository's pinned pack (`<repo>/.agents/skills/gantry/scripts/cli.py`) and executes it with `python3`; a shared downloads directory or a `gantry` on PATH is only a fallback convenience, never the primary resolution. When no pack copy exists, the project shows whatever the deterministic board read can and does not offer execution.
7. **Total replacement of the conversational orchestrator.** The coordinator chat, host-assisted command preparation, TypeScript plan engine and round engine, LLM provider settings, role dispatch, subagent steering, worktree takeover, role-replacement recovery, lesson candidates and cleanup authorization are removed from the orchestration path. What remains: project sidebar, the Issues/Specs board, the Run screen with its pauses and actions, standalone terminals, the file viewer, and settings for terminal and remote access. The harness never calls a model on its own behalf; roles run windowless inside the `execute` child per `execution.roles`, project config overriding global.

## User Stories

### Project loading and board

1. As an operator, I want to open a code directory and, when the pack is installed, immediately see its Issues and Specs as a horizontal Kanban, so that I never have to bootstrap through a chat.
2. As an operator, I want the harness to offer no execution affordance when the opened directory lacks the pack, so that I cannot start a Run the repository cannot support.
3. As an operator, I want every Issue that no Run is executing to sit in the Issues lane and display **ready to agent** or **blocked**, and every Spec to sit in the Specs lane, so that the board reflects the repository's files rather than harness bookkeeping.
4. As an operator, I want the board to be read by deterministic commands from the repository's files, so that a refreshed board never depends on a model or on harness-side state.
5. As an operator, I want Spec cards to be visibly non-executable support documents in the Specs lane, so that I never mistake a Spec for work that can run.
6. As an operator, I want each blocked Issue card, still in the Issues lane, to show its open blockers, so that I understand why a card is unavailable before I try to run it.
7. As an operator, I want a card whose blockers are all done on the target to become available again on the next board read, so that unblocking never needs a manual refresh ritual beyond reloading the board.
8. As an operator, I want the lanes Specs, Issues, Plan, Implement, Review, Critic and Done to stay visible in that order and to scroll horizontally, so that a Run's phase is a column and not a second board.
9. As an operator, I want an Issue in a live Run to move into the Plan, Implement, Review or Critic lane that matches the role in progress, and into Done only when the target says the Issue is done, so that I can see where work sits without opening a separate Kanban.
10. As an operator, I want each Spec card to open its documentation and each Issue card to open its Spec, and I want a card in an execution lane to let me follow the running agent and answer prompts, pauses and blockers inside that card, so that interaction stays on the board.

### Executing Issues and waves

11. As an operator, I want to select one Issue card and start a Run for it, so that the pack creates the Issue branch and worktree and begins work without me composing a command.
12. As an operator, I want to execute a whole wave so that one Run is enqueued per Issue in frontier order, letting independent Issues progress together.
13. As an operator, I want an Issue with an open blocker to refuse starting while staying in the Issues lane without a worktree or Run, so that dependencies are enforced by the pack rather than by my memory.
14. As an operator, I want each running Issue to have its own Run, branch and worktree, so that parallel work never shares a checkout.
15. As an operator, I want several Runs to advance at the same time when none depends on another, each card in its own execution lane, so that a board of independent Issues finishes sooner.
16. As an operator, I want each Run's harness-side record kept in harness state rather than in the repository or the PR, so that restarts and UI state never pollute the tracked files.

### Plan runs

17. As an operator, I want to start a Plan for work that has no Spec or Issue yet by giving a slug, so that the pack reserves the next number and creates the branch with its final name.
18. As an operator, I want the Run to pause inside the card once the plan has written the Spec and Issue, with the Spec in the Specs lane and the Issue in the Plan lane, so that nothing proceeds to implementation without my review.
19. As an operator, I want approval to continue in the same worktree and move the card through Implement, Review and Critic, so that an accepted plan flows into delivery without a new checkout.
20. As an operator, I want rejection to delete the worktree and branch, discard the Run and leave no card in any lane, so that a refused plan leaves no residue.
21. As an operator, I want a plan that ended with loose files to surface its pause inside the card only after the executor already retried once, and to let me try again or reject without spending correction budget, so that transient dirt does not cost a correction.
22. As an operator, I want plan-time edits to the Spec or Issue to require a commit before approval, so that the approved baseline is always committed content.

### Pauses during execution

23. As an operator, I want a clear, actionable prompt inside the card whenever a role asks for an answer, so that human input happens only where the process requests it.
24. As an operator, I want a corrections-exhausted pause to offer continuing with one more correction for that Run only, or stopping without merge, so that budget decisions stay scoped and explicit.
25. As an operator, I want stopping at exhausted budget to leave the Run interrupted with its worktree and branch, without the card returning to the ready-to-agent label, so that partial work is preserved honestly.
26. As an operator, I want the board card — not a model conversation — to remain my surface while roles execute windowless under the configured `execution.roles`, so that I always know where control lives.

### Resume and discard

27. As an operator, I want resuming an interrupted Run to continue in the same worktree and return the card to the lane of its last phase, so that prior work is never thrown away.
28. As an operator, I want resuming a Run whose budget is at zero to re-open its pause inside the card rather than call a role, so that the process never burns budget I have not granted.
29. As an operator, I want resuming a Run with remaining budget to continue from the last incomplete role, so that progress is not replayed.
30. As an operator, I want discarding a Run to remove its worktree and local branch, so that abandoned work does not accumulate.
31. As an operator, I want discarding a plan-born Issue that never reached the target to leave no card in any lane, while discarding a Run for an Issue already on the target returns that card to the Issues lane as ready to agent, so that the board always reflects repository truth.

### Approval, pull request and done

32. As an operator, I want a finished Run to offer the approval command on its card without calling any role and without a new lane, so that finalizing is one explicit deterministic action.
33. As an operator, I want approval to run in the same worktree, create the closing commit marking the Issue and roadmap done when it does not yet exist, push and open the PR — or only open the PR when the closing commit is already on the branch — so that the close is never duplicated.
34. As an operator, I want the Run to store the opened PR's URL and keep the card out of the Done lane, so that approval is a tracked step, not the end of the story.
35. As an operator, I want the harness to monitor approved-but-not-done cards, so that merge detection is automatic.
36. As an operator, I want a merged PR to move the card to the Done lane because the target already contains the closing commit, and the harness to delete the worktree and local branch while writing nothing more, so that cleanup follows repository truth.
37. As an operator, I want a PR closed without merge to end the Run without done, keep the card in the Issues lane outside the ready-to-agent label, remove the local worktree, and let reopening the PR repeat only the approval step, so that an unmerged close is never mistaken for delivery.
38. As an operator, I want the remote branch's fate left to the forge, so that the harness never deletes remote refs.

### Process lifecycle and reattachment

39. As an operator, I want in-flight Runs discovered after a harness restart from the repository's run records and Issue branch names, and their cards placed back in the matching lane, so that a restarted app can reattach and re-render state truthfully.
40. As an operator, I want done state always re-read from the target rather than from stale harness bookkeeping, so that external merges move the card to Done.
41. As an operator, I want closing the harness to leave each Run's repository-side record intact, so that resuming later works even when the child process is gone.
42. As an operator, I want an `execute` child that exits unexpectedly or emits an unreadable line to surface as a failed/paused Run on its card rather than a silent drop, so that I can always resume or discard deliberately.

### Board state correctness

43. As an operator, I want lane placement derived per card — Specs for every Spec, Done only from target status, Plan/Implement/Review/Critic only from a live Run, Issues otherwise — and the phase label taken from repository state, so that a card is never stuck in a lane the repository contradicts.
44. As an operator, I want the board to re-read the repository after Run events, so that card state tracks file truth instead of event history alone.
45. As an operator, I want parallel Runs from different cards never to share stdin, stdout parsing or worktree state, so that one Run's pause can never consume another Run's answer.

## Implementation Decisions

### 1. Pack resolution (repo-pinned, PATH as fallback)

- **Primary resolution**: `<repoRoot>/.agents/skills/gantry/scripts/cli.py`, invoked as `python3 <cli.py> --cwd <repoRoot> <subcommand> [args]` with the project directory as working cwd. This honors the PRD: the pinned copy executes, there is no global binary requirement.
- **Fallback**: when the repo-pinned `cli.py` is absent but a `gantry` executable resolves on `PATH`, the harness may invoke `gantry <subcommand>` instead — the npm bin already routes these subcommands into the installed pack's `cli.py`. Detection and availability are reported per project.
- **No pack, no execution**: when neither resolution succeeds, the board shows what `issues`/`specs`/`board` could read (typically nothing) and every run/plan/approve affordance is disabled with an explanatory state.

### 2. Board reads and lanes

- The board data source is `cli.py board --cwd <repo>` (equivalently `issues`, `specs`, `frontier` subcommands), parsed from its single JSON object on stdout: `issues[]` (`ref`, `spec`, `number`, `title`, `status`, `path`, `frontierBlocked`, `openBlockers`), `specs[]` (`slug`, `path`, `executable`), `frontier[]` (refs in execution order).
- The only columns are the seven lanes, left to right: `specs`, `issues`, `plan`, `implement`, `review`, `critic`, `done`. The lane strip scrolls horizontally. Empty lanes stay on the strip.
- **Lane placement** (first match wins):
  1. Spec → `specs`.
  2. Issue `status` done on the target → `done`.
  3. Live unfinished Run overlay whose column is Plan, Implement, Review or Critic → that lane. Integrate maps to `critic` and is not its own lane.
  4. Otherwise → `issues`. That includes ready to agent, blocked, interrupted with no live column, and approved-pending-merge. None of those states adds a column.
- **Phase label** on an Issue card, independent of lane: **ready to agent** when the Issue is not done and `frontierBlocked` is false; **blocked** while `frontierBlocked` is true, with `openBlockers` listed on the card; **done** when the Issue is done on the target. Overlays never rewrite Issue or Spec files.
- **Card actions**:
  - Spec card: open the spec file in the file viewer (`Abrir documentação`).
  - Issue card: open the attached spec in the file viewer when one exists (`Abrir spec`).
  - Issue card in `plan`, `implement`, `review` or `critic`: follow the executing agent (`Acompanhar agente`), which opens that Run's terminal or conversation.
  - When that Run is waiting on the operator, the prompt, pause, question or blocker is rendered inside the card and the answer is written to that Run. If the Run is waiting and no interaction payload is mounted yet, the card says the agent is waiting for an answer.

### 3. Run supervisor and JSONL protocol

- A server-side supervisor owns one `execute`/`resume`/`approve`/`discard` child per Run, keyed by `(projectId, ref)`, reusing the existing pane/process supervision seam rather than adding a third process model.
- The supervisor parses stdout line-delimited JSON and feeds the operator's pause answers to the child's stdin. Wire contract (consumed verbatim, `pushed` copied through):

```ts
// Events the harness must handle (one JSON object per stdout line)
type GantryEvent =
  | { event: 'worktree'; branch: string; worktree: string; pushed: boolean }
  | { event: 'pause'; reason: 'plan-approval' | 'corrections-exhausted' | 'plan-dirty';
      choices: string[]; branch: string; worktree: string; pushed: boolean }
  | { event: 'stopped'; branch: string; worktree: string; pushed: boolean }
  | { event: 'ready-for-approval'; branch: string; worktree: string; pushed: boolean }
  | { event: 'pull-request'; branch: string; target: string; worktree: string;
      pushed: boolean; createdCommit: boolean; url: string }
  | { event: 'rejected' | 'discarded'; branch: string; pushed: boolean }
  | { error: { code: string; /* plus code-specific fields */ } };
```

- Pause answers are the literal choice words (`approve`, `reject`, `continue`, `stop`, `try-again`) written as a single line on the child's stdin — the child blocks on `readline`, so the answer must be flushed with a newline and only when a `pause` is outstanding.
- A non-JSON stdout line, a child exit while a pause is unanswered, or a nonzero exit without a terminal event marks the Run failed/interrupted and is surfaced; the pack-side run record under `.git/gantry-cli/` remains authoritative for resume.

### 4. Run registry and card overlay

- The harness persists a Run record per `(projectId, ref)` in its existing state store: ref, slug, kind (`issue` | `plan`), child pid/handle, `branch`, `worktree`, paused reason + choices, last terminal event, PR url, and derived card phase. Records live under the harness home, outside the repository.
- Card lane is computed `repositoryState ∪ runOverlay`: done on the target always wins the Done lane; a live overlay supplies Plan, Implement, Review or Critic; everything else stays in Issues. The phase label still comes from repository truth. Board re-reads happen on Run terminal events and on explicit refresh. Pauses render inside the card in its current lane.

### 5. Plan flow

- `execute <slug>` is spawned only when the repo read shows no existing spec/issues for that slug (the pack itself errors `spec-or-issue-exists` otherwise).
- The `plan-approval` pause renders Spec and Issue file paths (from the run record's artifact paths) with a link into the file viewer; approval writes `approve`, rejection writes `reject`.
- The `plan-dirty` pause renders `try-again`/`reject` and is surfaced without consuming budget — the pack already retried once before pausing.

### 6. Approval and merge watching

- `approve <ref>` runs synchronously in the Run's worktree; the emitted `pull-request` event's `url` is stored on the Run record and shown on the card. Errors (`worktree-dirty`, `push-failed`, `pull-request-failed`, `remote-missing`) surface as card-level failures with the pack's error code.
- After approval, the Run is in `approved-pending-merge`. A watcher (poll loop on board/target read plus `git fetch`-free local target check — see Further Notes) re-reads the target branch: when the Issue is done there, the card flips to done and the harness removes worktree and local branch via `git worktree remove` + `git branch -D` locally only. A closed-unmerged PR ends the Run without done; reopening re-offers approval.

### 7. Wave execution and parallelism

- Executing a wave reads `frontier` and enqueues one `execute` per ref in that order. Each child is independent: separate stdin/stdout, separate worktree, separate registry entry. The supervisor imposes no artificial cap but surfaces each pause independently in the Run screen.
- An Issue whose `frontierBlocked` is true on the current board read cannot start; the UI explains the open blockers and the pack would refuse anyway (`open-blocker` error).

### 8. Removal of the conversational orchestrator

- Deleted from the orchestration path (and from required tests): coordinator chat, `commands/prepare` host-assisted preparation, the TypeScript plan workflow (grilling rounds, spec synthesis, draft-issue editing, plan approval card driven by harness-side LLM), the TypeScript round engine (frontier computation, worktree creation, role dispatch and result-contract validation, budget tracking, learner, cleanup authorization), subagent steering, worktree takeover, and role-replacement recovery. Their endpoints and UI stop being exercised; the code may be excised in the same pass or left unreachable, but this spec's acceptance treats them as absent.
- Kept: project registration and sidebar, board rendering, terminal panes (standalone shells/agent CLIs untouched by orchestration), file viewer, terminal settings, pairing/remote access, workspace layout persistence. Opening workspace state keeps the active session inside the active project: a project with no sessions gets one titled `Main Workspace Session`, and a saved id that is missing or belongs elsewhere is replaced and saved. Setup configuration of `execution.roles` remains through the existing settings surfaces since the pack consumes them.
- The harness never dispatches a role, never picks the next role, never calls a model. All role execution happens inside the `execute` child from the repository's `execution.roles` (project config over global).

### 9. Module boundaries

- **New `gantryCli.ts`** (server): pack resolution (`resolvePackExecutable`), deterministic board reads (`readBoard`, `readFrontier`), and argv builders for `execute`/`resume`/`approve`/`discard`.
- **New `runSupervisor.ts`** (server): child lifecycle, JSONL line parsing, pause registry (`awaitingAnswer`), stdin answer writer, terminal-event application to the Run registry, reattach scan of `.git/gantry-cli/*.json` records plus `git worktree list`/`branch` verification on startup and project open.
- **Run registry**: extends `HarnessStateStore` with per-project run records (keyed by ref) rather than a parallel store.
- **HTTP/WS surface**: `GET /api/projects/:id/board`; `POST /api/projects/:id/runs` (body: ref or slug + kind); `POST /api/projects/:id/runs/:ref/answer` (`{choice}`); `POST /api/projects/:id/runs/:ref/resume|discard|approve`; `POST /api/projects/:id/waves/execute`. WS events `run.event`, `run.paused`, `run.finished`, `board.changed` replace `runlog.event` for this flow.
- **Client**: the board is the primary surface and renders the seven lanes with horizontal scroll. Pauses and operator answers live inside the card of the Run they belong to. Following an agent opens that Run's terminal or conversation. The old conversation tab and "Main Workspace session" flows the PRD calls confusing are removed from the primary navigation.
- `planEngine.ts`, `roundEngine.ts`, `aiService.ts`, `aiConnection.ts` and provider settings are excised or reduced to dead code; `types.ts` drops `DecisionCardPayload`, `RunLifecycleState` and provider types in favor of the Run/card model above.

## Testing Decisions

### What makes a good test

- Test observable external behavior only: HTTP/WS responses, files in temporary Git repositories, the harness state store, and rendered UI. Never assert on supervisor internals or mocked JSONL parsing internals — drive the real `cli.py` with controlled role-command fixtures, exactly as `gantry/tests/test_gantry_cli.py` does.
- Temporary `git init -b main` repositories with a minimal pinned pack copy (`cli.py` + `common.py` + `roadmap.py` and a `.gantry/config.json` declaring executable fixture role commands) give end-to-end coverage without network or real models.

### Primary testing seam

- **Server integration (Vitest)**: spawn the harness server against a temp repo. Cover: board read with pack present/absent; `execute` issue → worktree event → role fixtures produce `ready-for-approval`; `plan-approval` pause answered via stdin; `corrections-exhausted` continue/stop; `plan-dirty` try-again/reject; `approve` stores PR url (fixture `gh` or `push` stub); `resume` reattaches after server restart by reading `.git/gantry-cli` records; `discard` removes worktree/branch and returns the card to ready to agent; parallel runs on independent refs never cross answers.
- **Browser (Playwright)**: the board renders the seven lanes in order with horizontal scroll; Specs stay in Specs and are non-executable; Issues show ready to agent or blocked with open blockers; a live overlay moves a card into Plan, Implement, Review or Critic and offers follow-agent plus in-card answers; done status places the card in Done after a target read; approved-pending-merge stays out of Done and shows the PR url.

### Prior art

- `gantry/tests/test_gantry_cli.py` for fixture repos driving real `cli.py` with executable role commands; existing `tests/slice*` files for the server-spawn pattern (to be rewritten against the supervisor seam rather than the deleted engines).

## Out of Scope

- Role order, verdicts, correction budget arithmetic, checks execution, micro-commit rules, closing-commit text and blocker rules — all owned by `cli.py` and the pack.
- Installing or updating the pack outside the consumer repository; the harness does not ship a Gantry binary.
- Embedding Claude Code, Codex or any model; the harness makes no model calls.
- A second PR/change to update the roadmap after merge.
- Remote branch deletion — the forge's rule applies.
- Coordinator chat, host-assisted command preparation, subagent steering, worktree takeover, role-replacement recovery, lesson candidates and cleanup authorization (removed, not redesigned).
- Non-interactive/headless harness CLI modes (`plan`/`run`/`setup` subcommands of `gantry-harness` CLI itself).

## Further Notes

- **Reattach details**: pack run records live at `<git-common-dir>/gantry-cli/<ref-with-#→-->.json` (`{ref, branch, phase, spent, granted, specPath?, issuePath?}`). `phase` values: `plan`, `plan-approval`, `implement`, `checks`, `review`, `critic`, `ready`. A record without a live harness child is an interrupted/adoptable Run; `phase: ready` records map to finished-awaiting-approval.
- **Merge detection**: the pack's `approve` pushes and opens the PR; the harness detects merges by re-reading the target. A pragmatic first pass polls `board`/`issues` output plus `git log`/`fetch` on the operator's cadence (manual refresh + interval); no webhook infrastructure is introduced.
- **`cli.py` requires a clean-ish spawn**: `execute` refuses when the branch or worktree already exists (`branch-exists`) and when blockers are open (`open-blocker`); both surface as card-level messages, not crashes.
- **Answer discipline**: pause answers must be single lowercase words from the emitted `choices`; anything else falls through to the child's next readline behavior (treated as the first non-matching choice semantics — effectively not the requested action). The UI only offers the emitted choices.
- **Plan-born card disappearance**: after `rejected`, no Issue file exists on the target, so the board naturally shows no card — the harness must not synthesize one from its registry.
- **Contradicts** `.scratch/gantry-harness/spec.md` sections "Deterministic Gantry Workflow Engine + Conversational Edges", "Primary AI Provider Abstraction", "PTY Manager, Live Role Streaming, Chat⇄Terminal & Steering" and "Decision Cards & State Machine Schema", which are superseded as described above. Surface-level pieces (PTY supervisor for standalone terminals, state store, WS broadcast) are retained and reused.
