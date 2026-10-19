# Desktop workspace and execution clarity

Status: implemented; macOS verified; Windows/Linux verification pending CI

## Confirmed requirements

Desktop application for macOS, Windows and Linux. The workspace is three areas: **Quadro**, **Terminal** and **Files**. The Quadro is the only board of Issues, Specs and run phases. The terminal is the agent surface. There is no conversation session and no separate "Acompanhar execução" view.

## Current gaps

- CLI bin points to an unbuilt `dist/cli.js`; build only emits client assets.
- No desktop entry or distributable packaging exists.
- Static assets resolve from the selected repository's cwd rather than the installed app.
- Python `pty.spawn` requires Unix and has no viewport resize protocol.
- Frontend remembers one active pane and exposes no terminal tab management.
- Sidebar and persistent onboarding consume working space; the mobile layout stacks navigation above the workspace.

## Implementation

Electron owns the desktop window and local server lifecycle. Keep React and xterm; use node-pty for Unix PTYs and Windows ConPTY. Resolve bundled assets independently of the selected repository. Provide desktop package targets for all three operating systems.

Replace the busy workspace shell with compact project navigation and one focused area at a time.

## Workspace layout

Sidebar workspace entries are **Quadro** and **Terminal**, then **Configurações**. The header switches **Quadro**, **Terminal** and **Files**. Opening a project lands on the Quadro.

- **Quadro** lists Specs and Issues and moves an Issue through Plan, Implement, Review, Critic and Done while a run is active. Pauses stay on the card. The pending-decision count sits on this entry.
- **Terminal** is shell and agent-CLI panes. While a project phase is active, the strip offers **Ver quadro**, which returns to the board.
- **Files** is the tree and the file viewer.

There is no "Acompanhar execução" view. There is no conversation tab, no "Main Workspace Session" entry, and no composer that sends a prompt to a host. The operator talks to Codex, Claude, OpenCode or the shell in a terminal pane.

## Acceptance

- Desktop starts its backend and opens its own window without requiring a separately installed Bun or Node runtime.
- Directory selection is available through the desktop file picker.
- Multiple terminal tabs preserve output when switching; closing a tab stops its process; resizing changes PTY dimensions.
- Navigation offers Quadro, Terminal and Files, and does not offer a conversation or a second execution board.
- Layout is usable at 390px width and short desktop window heights; navigation is dismissible.
- Existing planning, setup, artifacts, recovery and approval flows remain functional.
- Build, type checks and relevant tests pass. Report local macOS verification separately from unverified Windows/Linux runtime behavior.

## Evidence

Baseline on 2026-10-15: 35 tests passed in 9 files. Existing tests do not establish desktop packaging or responsive layout quality.

## Delivery verification

- 39 tests in 10 files pass after the change; type checking and production build pass.
- Electron desktop startup and packaged macOS Apple Silicon startup pass. DMG and ZIP generated locally; unsigned.
- A real integrated shell executed a diagnostic command and reported PTY dimensions. Native resizing and tab switching were checked.
- Browser viewport checks at 1280x800, 768x620 and 390x540 show no horizontal body overflow. At 390x540 the composer bottom is 507px and the terminal keeps 329px of working height.
- Independent finish review passed against the supplied recording and captured desktop/mobile images in `screenshots/`.
- Windows/Linux package targets and native PTY tests are included in the CI matrix. Those jobs have not been run remotely here.
- Production dependency audit reports no vulnerabilities. Full developer-tool audit retains one moderate transitive `sprintf-js` advisory from Electron's download tooling, with no patched registry version available at verification time.
