# Spec: Gantry Harness (`gantry-harness`)

Type: spec
Status: ready-for-agent

Workspace layout, as of 2026-10-19: primary areas are **Quadro**, **Terminal** and **Files**. The Quadro is the only board (Specs, Issues, Plan, Implement, Review, Critic, Done). There is no separate "Acompanhar execução" Kanban and no conversation session. Terminal panes are the agent surface. Sections below that describe Chat ⇄ Terminal, the eight-column embedded Kanban, coordinator chat and the conversational orchestrator are superseded by `.scratch/run-orchestration/spec.md` and `.scratch/desktop-experience/spec.md`.

## Problem Statement

Operating Gantry today requires the developer to manually coordinate an external Host Harness (such as Claude Code, Codex CLI, OpenCode, or Antigravity), invoke slash skills inside separate terminal sessions, mentally track multiple Issue Worktrees, and switch between terminal windows, markdown files, and a read-only Dashboard when an agent awaits input or encounters a Protocol Failure or Execution Failure.

Terminal-only TUIs are often constraining when managing multiple concurrent Repository Execution Units, inspecting Spec and Issue artifacts alongside diffs, answering Socratic Gate ("Grilling") cards, and switching between structured agent conversations and live interactive terminals (`claude`, `codex`, `opencode`, `agy`). Operators lack a unified, standalone, local-first agentic application—combining the block-based conversational ergonomics of OpenCode and Warp with the multi-workspace, Chat-to-Terminal toggle, and one-tap decision cards of `herdr-web-ui`—that natively drives Gantry's deterministic Software Factory from initial repository bootstrap and Grilling through Spec synthesis, Planning Approval, multi-round TDD execution, Adversarial Review, live agent steering, and final Run Pull Request handoff.

## Solution

Build `gantry-harness`, an independent, local-first CLI and web application (TypeScript on Bun/Node.js backend with a React, Vite, and `xterm.js` frontend) that serves as an interactive Host Harness and workspace manager for Gantry.

When launched via the `gantry-harness` CLI, the application starts a single-instance local server (loopback `127.0.0.1` by default, with optional paired LAN/Tailscale access) and opens a rich browser UI that automatically restores the operator's last active workspace state (registered projects, active sessions, open tabs/splits, and ongoing Runs).

Within `gantry-harness`, the operator can:
1. **Manage Multiple Projects & Issue Worktrees in a Left Sidebar**: Switch between repositories, automatically load each repository's Repository Policy, machine-local operator profile, and Execution State, inspect nested Issue Worktrees and active agents with live status indicators (`working`, `needs input`, `done`, `blocked`), and receive real-time cross-project alerts whenever an agent or Run requires operator attention.
2. **Bootstrap & Configure Gantry Visually or Conversationally**: Automatically detect whether Gantry skills and Repository Policy exist in a target project, install/update Gantry skills when needed, and configure Repository Readiness, Available Role Models, Role Execution Selections, Verification Command Approvals, Guard Hooks, and operator profiles through either a visual Settings/Setup panel (backed by Gantry's discovery and setup Workflow Scripts) or a conversational `/setup` flow.
3. **Conduct Interactive Grilling & Spec Synthesis (`/plan`)**: Connect directly to an LLM provider via SDK/API (Anthropic, OpenAI, Gemini, OpenRouter) or delegate to a locally authenticated harness CLI to run dynamic, multi-round Socratic Gate interviews rendered as interactive decision cards alongside free-form chat. The conversation follows the operator's or repository's language guidelines while generating canonical English Gantry artifacts (`Spec`, `Issue` drafts, `Result Contract` payloads) that pass Spec Structural Validation, Requirement Review, parallel research, tracer-bullet slicing, Initial Context Budget audits, and Plan Critic validation before presenting an interactive Planning Approval card.
4. **Orchestrate the Deterministic Gantry Software Factory (`/run`, `/resume`) with Live Streaming & Steering**: Execute Gantry's canonical planning and round state machines deterministically against Gantry's Python Workflow Scripts while streaming every role invocation (`research`, `planner`, `requirement-critic`, `plan-critic`, `implementer`, `reviewer`, `critic`, `learner`) in real time. At any point, the operator can converse freely with the coordinating agent, steer running subagents (`Queue` for next turn or `Send Now` to interrupt/inject into the live PTY), take over an Issue Worktree in an interactive terminal session, and resume the Gantry Run without losing state or Correction Budget tracking.
5. **Switch Seamlessly Between Structured Chat, Live PTY Terminals (`Chat ⇄ Terminal`), Kanban, and Artifacts**: Open dedicated PTY terminals for `claude`, `codex`, `opencode`, `agy`, or a system shell in any project or Issue Worktree, toggle any agent pane with one click between structured Chat (folding tool calls and edits per turn) and live `xterm.js` Terminal, inspect the embedded Gantry Run Kanban, view artifacts/diffs in an integrated drawer, and handle operational recovery (`issueRoleReplacements`), Lesson Candidates, Run Pull Request creation, and Cleanup Authorization via native action cards.

## User Stories

### Application Lifecycle, CLI & State Persistence
1. As an operator, I want to run `gantry-harness` in my terminal to start the local application server and open the web interface, so that I can manage my Gantry projects from a unified visual and terminal workspace.
2. As an operator, I want `gantry-harness` to automatically restore my complete previous application state (registered projects, last active project, open terminal tabs, split panes, and terminal scrollback) when reopened, so that I never lose context after closing the app or restarting my machine. The workspace does not restore a conversation session.
3. As an operator, I want running `gantry-harness` inside a project directory when an instance is already running to register or focus that project in the existing server instance rather than spawning conflicting servers, so that all my active repositories live in one sidebar.
4. As an operator, I want CLI subcommands such as `gantry-harness setup`, `gantry-harness plan "<goal>"`, and `gantry-harness run <scope>` to focus the current repository in the application and immediately initiate the requested workflow, so that I can trigger actions quickly from the command line.
5. As an operator, I want a `--headless` / non-interactive CLI mode for already-approved scopes, so that I can run deterministic Gantry rounds in automated or remote terminal environments when a browser is not needed.
6. As an operator, I want all application state (registered projects, session transcripts, UI layout, and global LLM provider configurations) persisted in a dedicated user-level directory outside my Git repositories, so that my repositories remain clean of harness-specific UI state.

### Sidebar, Multi-Project Workspace & Real-Time Alerts
7. As an operator, I want a left sidebar listing all my registered projects (Repository Execution Units), so that I can switch between repositories with a single click.
8. As an operator, I want to add new local directories as projects or remove existing ones from the left sidebar, so that I can curate my active workspaces.
9. As an operator, I want `gantry-harness` to automatically load a project's Repository Policy, machine-local operator profile, `AGENTS.md`, `ROADMAP.md`, Specs, and Issues as soon as I select or add the project, so that its configuration is immediately reflected in the UI without manual import.
10. As an operator, I want active Issue Worktrees and running role or standalone agents nested under their parent project in the sidebar, so that I can see the exact branch and worktree topology at a glance.
11. As an operator, I want each project, Issue Worktree, and agent row in the sidebar to display a live state badge (`working`, `needs input`, `done`, `blocked`, `idle`), so that I immediately know what is progressing and what is stalled.
12. As an operator, I want a drop-in visual alert and optional browser/Web Push notification whenever any agent or Run in any project transitions to `needs input` or `blocked`, so that I can work in another project or tab and jump directly to the pending decision card with one click.
13. As an operator, I want quick-access controls in the sidebar to switch between conversation sessions within a project, open Gantry Setup, and open Global Settings, so that navigation never requires leaving the workspace.

### Gantry Bootstrap, Repository Setup & Model Discovery
14. As an operator, I want `gantry-harness` to detect whether a selected repository has the Gantry skill pack and Repository Policy installed, and offer one-click automatic installation or update when missing or outdated, so that I can onboard any greenfield or brownfield repository effortlessly.
15. As an operator, I want a visual Gantry Setup & Settings panel that queries Gantry's model discovery script for each installed harness (`claude-code`, `codex`, `opencode`, `antigravity`), so that I only select verified Available Role Models and supported reasoning effort levels.
16. As an operator, I want to configure Role Execution Selections (`harness`, `model`, `effort`, and optional sandbox mode) independently for each Gantry role (`plan`, `research`, `implement`, `review`, `critic`, `requirement-critic`, `plan-critic`, `learner`), so that I can combine strengths across harnesses while respecting role inheritance defaults.
17. As an operator, I want to configure Artifact Location Mapping, Effective Templates, Git Workflow Policy (target branch and branch prefix), Verification Command Approvals (absolute and differential Entropy Gate checks, including `browser-validation`), Guard Hooks (`record` and `deny`), and the Caveman lite preference from either the visual Setup panel or the `/setup` conversational assistant, so that Repository Readiness is achieved safely.
18. As an operator, I want every proposed change to the tracked Repository Policy to display a clear diff preview of the policy file and adapter files before I approve applying it via Gantry's setup script, so that no tracked configuration is mutated silently.
19. As an operator, I want the option to save my Host Harness preference and role overrides as a personal machine-local operator profile (leaving the repository's tracked policy and `AGENTS.md` untouched), so that my personal harness choices do not cause Git diff churn for teammates.
20. As an operator, I want `gantry-harness` to diagnose ignored Repository Policy files or Dirty Working Trees during setup and preflight and present actionable remediation cards, so that portability and baseline invariants are preserved.

### Primary AI Connection & Language Governance
21. As an operator, I want to connect `gantry-harness` to my preferred LLM provider via direct API/SDK (Anthropic, OpenAI, Google Gemini, OpenRouter, or compatible endpoints) in Global Settings, so that interactive Grilling, Spec synthesis, and coordinator chat run with low-latency streaming.
22. As an operator, I want the option to delegate the coordinator/planning AI to an already-authenticated local harness CLI (`claude`, `codex`, `opencode`, `agy`) instead of providing a separate API key, so that I can use my existing CLI subscriptions immediately.
23. As an operator, I want the coordinator agent to inspect the repository's `AGENTS.md` and domain documentation for language directives—conversing with me in my preferred language (or the repository-mandated language) while synthesizing canonical Gantry artifacts (`Spec`, `Issue` files, `AGENTS.md` blocks, `Result Contract` outputs, and `Run Pull Request` bodies) in the required format and language so that Spec Structural Validation and Critic checks always succeed.

### Interactive Grilling (`Socratic Gate`), Spec Synthesis & Planning Approval
24. As an operator, I want to start a planning flow via `/plan <goal>` (or by typing a goal in the Gantry Factory tab) that automatically explores the repository's context (`GLOSSARY.md` / `CONTEXT.md`, `PRD.md`, `docs/adr/`, existing modules, and exemplar Issues) in the background before asking me questions, so that every question is grounded in the actual codebase.
25. As an operator, I want the Grilling interview to be presented as rounds of interactive decision cards—where each question displays a numbered title, clear trade-offs/options, and a recommended answer that I can accept with one click, edit inline, or answer via free-form chat—so that we rapidly converge on a shared design tree.
26. As an operator, I want the Run Log to record `phase.started` with `operatorWaiting: true` during the Grilling interview and `operator.approved` when I respond, so that the Kanban and sidebar badges accurately reflect when the Run is waiting on me.
27. As an operator, I want the coordinator to synthesize the settled decisions into a canonical `Spec` file (` Blueprint`, `Contract`, `Definition of Done`, `Regression Guardrails`, `Scenarios` in Gherkin, `Out of Scope`, `Changelog`) and automatically run Spec Structural Validation (`spec.py --check`) and Requirement Review (`requirement-critic`), so that any structural error or ambiguity is caught before Issue slicing.
28. As an operator, I want blocking findings from Spec Structural Validation or the Requirement Critic to be displayed as an interactive card quoting the exact finding and offering one-click or conversational Spec refinement, so that I can amend the Spec and re-validate without leaving the chat.
29. As an operator, I want `gantry-harness` to automatically run parallel repository research, invoke the Planner to draft tracer-bullet vertical-slice Issues (with prefactoring isolated in Slice `#01` and `Status: draft`), measure each Issue's Initial Context Budget via `budget.py`, and run the adversarial Plan Critic (plus one automatic planner revision pass if refuted), so that I only review a budget-audited, DAG-validated Issue breakdown.
30. As an operator, I want a comprehensive **Planning Approval Card** showing the Spec preview, the visual dependency DAG and wave schedule of draft Issues, each Issue's Initial Context Budget percentage, and the Plan Critic verdict, so that I can inspect the entire plan in one place.
31. As an operator, I want to be able to ask the coordinator in natural language to split, merge, reorder, or refine specific draft Issues (or edit them directly in the integrated artifact editor) and re-run budget/critic checks before clicking **Approve Plan**, so that I have full interactive control over the breakdown.
32. As an operator, I want clicking **Approve Plan** to execute Gantry's authoritative transition commands (`roadmap.py status <ref> ready-for-agent`, `roadmap.py waves`, `roadmap.py check`) and offer a one-click transition into the implementation Run, so that `ROADMAP.md` and Issue statuses are never hand-edited.

### Deterministic Round Execution, Live Streaming & Multi-Agent Orchestration
33. As an operator, I want `/run <scope>` to execute Gantry's preflight checks—verifying a clean working tree, resolving the Repository Execution Unit (`unitId`), checking for in-flight Runs (`runlog.py inflight`) and spent Correction Budgets (`runlog.py corrections`), resolving the Host Harness (`execution.py host --require-resolved`), and running selected-profile preflight (`execution.py preflight`)—before any Issue implementation starts.
34. As an operator, I want `gantry-harness` to compute ready rounds exclusively via `frontier.py`, create isolated Issue Worktrees and branches for concurrent Issues in a round, mark worktrees with the active `runId` (`runlog.py mark`), and record every canonical lifecycle event (`run.started`, `round.started`, `phase.started`, `subagent.started`, `subagent.stopped`, `phase.finished`, `review.finding`, `refutation`, `issue.done`, `issue.blocked`, `round.finished`, `run.finished`) via `runlog.py append` using stdin JSON payloads.
35. As an operator, I want each role invocation (`implementer`, `reviewer`, review-fix `implementer`, `critic`, correction `implementer`, and optional `learner`) to stream its live activity to the UI in real time while still enforcing strict Result Contract validation via `result.py` (with one bounded retry on Protocol Failure) and projecting Critic `gateResult` payloads before appending to the Run Log.
36. As an operator, I want `gantry-harness` to integrate Critic-accepted, gate-green, clean Issue deliveries serially into the Run branch (`git merge --no-ff`), run declared repository gates (`gates.py --run`) after every merge, and invoke `roadmap.py done <ref>` only after verification passes, halting immediately if a post-merge gate fails.

### Continuous Operator Interactivity, Live Steering & Worktree Takeover
37. As an operator, I want the coordinator chat input to remain active at all times during planning and implementation Runs, so that I can ask questions about the codebase, inspect status, or issue natural-language instructions to adjust the workflow whenever needed.
38. As an operator, I want an active steering bar on any running subagent pane with **Queue (Next Turn)** and **Send Now (Steer / Interrupt)** actions, so that I can either queue guidance for the next correction/review pass or immediately inject guidance into the running agent without losing the Issue Worktree.
39. As an operator, I want a one-click **Takeover in Terminal** button on any Issue Worktree that pauses the automated phase for that Issue, opens an interactive agent CLI (`claude`, `codex`, `opencode`, `agy`) or shell directly in that Issue Worktree's PTY, and provides a **Resume Gantry Pipeline** button once I finish my manual intervention, so that I can collaborate directly with the agent when a task is subtle or stuck.

### `Chat ⇄ Terminal` Toggle & Standalone Agent PTY Panes
40. As an operator, I want to open standalone interactive terminal panes (tabs or split views) inside any project or Issue Worktree with one-click launchers for `claude`, `codex`, `opencode`, `agy`, or the default shell, so that I can run ad-hoc agent sessions alongside Gantry Factory Runs.
41. As an operator, I want a one-click **`Chat ⇄ Terminal`** toggle on every agent pane—where **Chat view** renders a clean, structured transcript with tool calls, commands, and file diffs folded per turn, and **Terminal view** attaches a live `xterm.js` instance directly to the underlying PTY—so that I get both high-level readability and raw terminal control in the same pane.
42. As an operator, I want file paths printed in either the Chat view or Terminal view to be clickable, opening the referenced file or diff directly in the integrated artifact viewer/editor drawer.

### Embedded Kanban, Recovery, Lesson Candidates, Run PR & Cleanup Cards
43. As an operator, I want an embedded, real-time Kanban board view (compatible with Gantry's Run Log events across Ready, Plan, Implement, Review, Critic, Integrate, Done, and Blocked columns) inside `gantry-harness`, so that I can monitor all Runs across my Repository Execution Units without managing a separate dashboard process.
44. As an operator, I want Runtime Execution Failures (`issue.paused`), exhausted Correction Budgets (`issue.blocked`), or preflight failures to surface as an interactive **Recovery Card** that lets me inspect the sanitized diagnosis, select a validated `issueRoleReplacement` (`harness`, `model`, `effort`), or authorize a read-only preflight probe and resume the Run (`priorRun`) while preserving the existing Issue Worktree and spent Correction Budget.
45. As an operator, I want the end of a Run to automatically invoke `learner.py` when recurring refutations or review findings exist and present each **Lesson Candidate** as an interactive card showing its evidence and target file (`AGENTS.md`, `CONTEXT.md`, or template) for explicit acceptance or dismissal.
46. As an operator, I want the end of a Run to present a **Run Pull Request Card** displaying the generated English PR body (with authoritative criteria and Critic evidence per completed Issue) and a one-click button to open the draft PR against the configured target branch via `gh`, while never auto-creating or merging the PR without my confirmation.
47. As an operator, I want the end of a Run to execute `cleanup.py --plan --json` and present a **Cleanup Authorization Card** listing the exact merged Issue Worktrees and branches to be removed, executing `cleanup.py --yes --plan-file` only after I explicitly click to authorize that exact plan.

### Security & Remote Access
48. As an operator, I want the `gantry-harness` server to bind strictly to loopback (`127.0.0.1`) by default and never write credentials, raw API keys, or raw process streams into tracked Repository Policy, operator profiles, or Gantry Run Logs.
49. As an operator, I want an optional LAN/Tailscale access mode protected by one-time pairing codes and a mobile-friendly responsive layout with a virtual terminal keybar (`esc`, `tab`, `^C`, arrows), so that I can monitor Runs and tap approval cards from my phone or tablet just like in `herdr-web-ui`.

## Implementation Decisions

### 1. Application Architecture & Runtime Boundary
- **Stack**: TypeScript backend running on Bun / Node.js, paired with a React + Vite single-page web application using `xterm.js` for live terminal emulation.
- **Single-Instance Server & CLI Entrypoint**: Invoking `gantry-harness` checks a local lock/state file under the user's harness state directory. If no server is running, it starts the HTTP + WebSocket server bound to `127.0.0.1` (default port `7400`, configurable) and opens the browser. If a server is already running, the CLI sends an IPC/HTTP request to the active server to register/focus the current working directory (and optionally trigger a subcommand such as `setup`, `plan`, or `run`) and focuses the browser URL.
- **State Separation across Four Homes**:
  1. **Harness Application State (`~/.gantry/harness/`)**: A local SQLite database and `settings.json` storing registered projects, UI workspace layout (open tabs, split panes, active project/session, Chat vs. Terminal toggle state), coordinator conversation transcripts, and encrypted/local-only LLM API provider configurations. Opening an older `harness.db` adds missing columns in place: `projects.unit_id`, `projects.badge_state`, `projects.lifecycle_state` (default `idle`), `sessions.slug`, `messages.turn_blocks_json`, and `messages.decision_card_json`. Existing projects, sessions, and messages stay. `CREATE TABLE IF NOT EXISTS` does not perform this upgrade.
  2. **Tracked Repository Policy (`<repoRoot>/.gantry/config.json` & `AGENTS.md`)**: Written exclusively by invoking Gantry's `setup.py` after explicit operator approval.
  3. **Machine-Local Operator Profile (`~/.gantry/profiles/<unitId>/execution.json`)**: Written via `setup.py --personal` per ADR-0007, holding personal `hostHarness` and `roles` overrides without dirtying tracked repository files.
  4. **Observational Run State (`~/.gantry/state/<unitId>/runs/<runId>.jsonl`)**: Written exclusively through `runlog.py` and Gantry scripts; never mutated directly by the UI.

### 2. Deterministic Gantry Workflow Engine + Conversational Edges
- Rather than relying on an unconstrained LLM loop to guess which Gantry script to call next, `gantry-harness` implements a deterministic TypeScript state machine that mirrors `reference/plan-workflow.md` and `reference/round-workflow.md`.
- Every deterministic check and state transition delegates to the official Python Workflow Scripts located in the resolved `skillDir` (`common.py`, `execution.py`, `setup.py`, `discovery.py`, `spec.py`, `plan.py`, `budget.py`, `frontier.py`, `roadmap.py`, `gates.py`, `acceptance.py`, `result.py`, `runlog.py`, `learner.py`, `cleanup.py`).
- **Command Runner Contract**: The backend's `runCommand(command, { cwd, input, env })` implementation always pipes `input` to the child process's `stdin` (mandatory for `runlog.py append` and `result.py --json`) and captures `stdout`, `stderr`, and `exitCode` without interpolating untrusted JSON payloads into shell strings.
- **Host Harness Resolution Compatibility**: When calling `execution.py host --require-resolved --json`, `gantry-harness` reads the operator's confirmed host selection from the project's operator profile or Repository Policy (defaulting to the operator-confirmed supported identifier: `opencode`, `claude-code`, `codex`, or `antigravity`), ensuring immediate 100% compatibility with current `@julioborges/gantry` releases without requiring upstream changes to `SUPPORTED_HARNESSES`.

### 3. Primary AI Provider Abstraction & Language Policy
- **Multi-Provider AI Service**: Supports two execution backends for the Coordinator Agent (used for Setup guidance, Socratic Gate Grilling, Spec synthesis, and free-form operator chat):
  1. **Direct SDK/API**: Native streaming adapters for Anthropic, OpenAI, Google Gemini, and OpenRouter/OpenAI-compatible endpoints, supporting structured JSON output schemas for generating grilling cards and Spec sections.
  2. **Local CLI Bridge**: Uses an installed and authenticated harness CLI (`claude`, `codex`, `opencode`, `agy`) when the operator prefers zero API-key setup.
- **Language Policy Resolver**: Before starting a session in a project, the Coordinator inspects the repository's `AGENTS.md`, `CONTEXT.md` / `GLOSSARY.md`, and project settings. If the repository mandates a specific language in `AGENTS.md`, the Coordinator follows that mandate; otherwise, it converses with the operator in the operator's language while synthesizing all Gantry-validated artifacts (`Spec`, `Issue` files, `AGENTS.md` policy blocks, `Result Contract` JSON, and `Run Pull Request` bodies) in English so that `spec.py --check`, `Requirement Critic`, and `Plan Critic` validations succeed.
- **Host-scoped model catalog**: Role models and the coordinator model are selects of the models `discovery.py` reports for the host on that control. `claude` maps to `claude-code` and `agy` to `antigravity`. A Codex control cannot save an Anthropic model id. `providers.cli.modelsByHost` remembers one model per CLI host. When the conversation host comes from the project or profile and differs from the global `cliHarness`, the connection uses `modelsByHost` for the resolved host and does not send the other host's model. The conversation composer shows that resolved host and its model list, and a pending reply names the host and model in use.
- **No conversation session**: The workspace has no conversation transcript and does not connect a host to a conversation screen. `POST /api/projects/:id/chat` is absent. The operator uses a terminal pane for the agent CLI.
- **No second execution board**: "Acompanhar execução" is not a workspace area. Run phase is a lane on the Quadro. Following an agent opens a terminal pane, and the terminal returns to the Quadro.

### 4. PTY Manager, Live Role Streaming, `Chat ⇄ Terminal` & Steering
- **Unified PTY & Process Supervisor**: Both standalone user-launched terminals (`claude`, `codex`, `opencode`, `agy`, shell) and Gantry role dispatches run under a server-side PTY/process supervisor keyed by `(projectId, worktreePath, paneId)`.
- **Dual-Mode Transcript & Terminal Streaming**:
  - Raw PTY byte streams are broadcast over WebSocket to `xterm.js` instances when the pane is in **Terminal** mode (preserving scrollback buffer in memory/disk so switching modes never loses output).
  - A parallel transcript parser ingests structured events (from `runlog.py`, Codex JSONL rollouts, Claude/OpenCode session transcripts, or ANSI-stripped turn blocks) to render the **Chat** mode with collapsible tool/command blocks and clickable file paths.
- **Interactive Steering & Worktree Takeover**:
  - **Queue (Next Turn)**: Stores operator feedback in the active Issue's orchestration context and injects it into the prompt of the next scheduled role pass (e.g., review fix pass or Critic correction pass).
  - **Send Now (Steer)**: Writes operator input directly into the active PTY session or interrupts the current role invocation (`operator_stop` / `authorized_handoff`), appending the operator's instruction and re-dispatching the role in the preserved Issue Worktree.
  - **Takeover**: Marks the Issue phase as operator-held, opens an interactive CLI session in the Issue Worktree PTY, and upon clicking **Resume Gantry Pipeline**, verifies worktree/branch integrity and resumes the round state machine from the current phase.

### 5. Decision Cards & State Machine Schema
All operator gates in the Gantry lifecycle are represented as typed, interactive Decision Cards persisted in the session timeline and synchronized over WebSocket:

```ts
// Decision-rich state machine and card contract
export type RunLifecycleState =
  | 'idle'
  | 'bootstrapping_skills'
  | 'setup_review'
  | 'grilling_interview'
  | 'spec_validation'
  | 'requirement_review'
  | 'slicing_and_critique'
  | 'awaiting_plan_approval'
  | 'round_preflight'
  | 'round_executing'
  | 'awaiting_recovery_decision'
  | 'awaiting_handoff_decisions'
  | 'completed';

export type DecisionCardPayload =
  | {
      kind: 'grilling_round';
      slug: string;
      roundNumber: number;
      questions: Array<{
        id: string;
        title: string;
        body: string;
        options?: Array<{ label: string; description: string }>;
        recommendedAnswer: string;
      }>;
    }
  | {
      kind: 'spec_blocked';
      slug: string;
      source: 'spec_structural_validation' | 'requirement_critic';
      findings: Array<{ quote: string; reason: string }>;
    }
  | {
      kind: 'plan_approval';
      slug: string;
      specPath: string;
      issues: Array<{
        ref: string;
        title: string;
        path: string;
        blockedBy: string[];
        estimatedTokens: number;
        budgetTokens: number;
        overBudget: boolean;
      }>;
      waves: string[][];
      criticVerdict: { acceptable: boolean; problems: Array<{ problem: string; fix: string }> };
    }
  | {
      kind: 'issue_recovery';
      runId: string;
      issueRef: string;
      worktree: string;
      failureReason: 'execution_unavailable' | 'verification_unavailable' | 'correction_budget_exhausted' | 'preflight_failed';
      correctionsSpent: number;
      currentSelection: { harness: string; model: string; effort?: string };
      availableReplacements: Array<{ harness: string; model: string; effort?: string }>;
    }
  | {
      kind: 'run_handoff';
      runId: string;
      tier: string;
      runBranch: string;
      targetBranch: string;
      lessonCandidates: Array<{ id: string; evidence: string; target: string; draftRule: string }>;
      prDraft: { title: string; body: string };
      cleanupPlan: { worktreesToRemove: string[]; branchesToRemove: string[]; rawPlanJson: Record<string, unknown> };
    };
```

## Testing Decisions

### What Makes a Good Test
- Tests must verify observable external behavior at the highest boundary—HTTP/WebSocket API responses, persisted files in temporary Git repositories and state directories, Gantry Run Log JSONL events, and rendered browser UI interactions—never internal private methods or implementation details.
- Tests must exercise the real Gantry Python Workflow Scripts (`setup.py`, `spec.py`, `plan.py`, `frontier.py`, `roadmap.py`, `budget.py`, `result.py`, `runlog.py`, `gates.py`, `acceptance.py`, `cleanup.py`) inside isolated temporary Git repositories (`git init -b main`) with isolated `--state-root` and profile directories, using controlled test doubles only at the external LLM/harness CLI boundary.

### Primary Testing Seam
- **Unified Server HTTP/WebSocket + UI Integration Seam**:
  1. **Backend Integration Tests (Vitest / Bun Test)**: Spin up the `gantry-harness` server against temporary Git repositories and temporary `~/.gantry` state roots. Drive full workflows over HTTP and WebSocket: project registration, state restoration across server restarts, Gantry skill bootstrap, `/setup` policy preview and application, `/plan` Socratic Gate card rounds, Spec synthesis + `spec.py --check` + `Plan Critic`, Planning Approval transition (`roadmap.py`), multi-issue `/run` execution with worktree isolation, PTY terminal spawn and `Chat ⇄ Terminal` transcript streaming, live steering/takeover, `issueRoleReplacements` recovery, and `cleanup.py` authorization.
  2. **End-to-End Browser Validation (Playwright)**: Exercise the React + `xterm.js` frontend in a real headless browser against the local server, verifying sidebar project/worktree switching, live status badges and drop-in `needs input` alerts, interactive Grilling and Planning Approval cards, `Chat ⇄ Terminal` toggling, artifact/diff drawer inspection, and Kanban board updates.

### Prior Art
- Mirrors the subprocess and fixture-driven testing style of the Gantry repository (`tests/test_host_resolution_cli.py`, `tests/test_execution.py`, and Playwright dashboard validation), where temporary Git repositories and deterministic fixture binaries prove end-to-end protocol compliance without relying on live external network calls.

## Out of Scope

- **Replacing Gantry's Python Workflow Scripts**: `gantry-harness` does not rewrite `frontier.py`, `roadmap.py`, `gates.py`, `acceptance.py`, `spec.py`, `budget.py`, `result.py`, `runlog.py`, or `cleanup.py` in TypeScript; those Python scripts remain the single deterministic authority.
- **Automatic Merging into Target Branches**: In accordance with Gantry invariants, `gantry-harness` never merges a Run branch or Run Pull Request automatically; it only offers to create a draft Run Pull Request upon explicit operator confirmation.
- **Cloud-Hosted Multi-Tenant Relay**: All projects, PTYs, SQLite state, and Run Logs remain 100% on the operator's machine; remote phone/tablet access relies on loopback tunneling, LAN, or the operator's own Tailscale/VPN rather than an external cloud account service.
- **Automatic Model or Harness Fallback**: If a configured harness or model fails during a Run, `gantry-harness` never silently substitutes another model or harness; it pauses the affected Issue and presents an explicit Recovery Card to the operator.

## Further Notes

- **Skill Pack Resolution**: `gantry-harness` resolves a repository's Gantry skill pack in the canonical priority order (`<repoRoot>/.agents/skills/gantry` first, then `~/.agents/skills/gantry`, or installs via `@julioborges/gantry` during bootstrap).
- **Guard Hook Compatibility**: When spawning standalone or role agents inside a project or Issue Worktree, `gantry-harness` preserves Gantry's `runlog.py mark` worktree markers and `GANTRY_RUN_ID` environment variables so that Gantry's git hooks (`pre-commit`, `pre-push`) and harness Guard Hooks record `hook.denied` events accurately.
