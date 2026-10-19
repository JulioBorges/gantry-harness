# Desktop workspace and execution clarity

Status: implemented; macOS verified; Windows/Linux verification pending CI

## Confirmed requirements

Desktop application for macOS, Windows and Linux. Follow the supplied herdr recording's simple workspace interaction. The Gantry coordinator conversation and standalone terminal sessions are separate. Gantry command shortcuts consult the configured Agent Host to help format commands before execution.

## Current gaps

- CLI bin points to an unbuilt `dist/cli.js`; build only emits client assets.
- No desktop entry or distributable packaging exists.
- Static assets resolve from the selected repository's cwd rather than the installed app.
- Python `pty.spawn` requires Unix and has no viewport resize protocol.
- Frontend remembers one active pane and exposes no terminal tab management.
- Sidebar and persistent onboarding consume working space; the mobile layout stacks navigation above the workspace.
- Chat/Terminal switching is ambiguous about coordinator versus CLI context.

## Implementation

Electron owns the desktop window and local server lifecycle. Keep React and xterm; use node-pty for Unix PTYs and Windows ConPTY. Resolve bundled assets independently of the selected repository. Provide desktop package targets for all three operating systems.

Replace the busy workspace shell with compact project navigation, session tabs, context header and focused conversation/terminal views. Expose command shortcuts with a host-assisted preparation step; retain explicit execution. Show pending decisions and phase context without permanently expanding advanced settings.

## Conversation follows the configured host

The composer shows the host that will answer the next message. A project or personal-profile host wins over the global CLI host and is shown as fixed text (`Host do projeto` or `Host do perfil`). The model control is a select of that host's discovered models, the same catalog Settings uses. Choosing a model saves it for that host under `providers.cli.modelsByHost` and the next chat call passes that id as `--model`. A model remembered for a different host is not sent.

While the host is replying, the thread shows the operator message and a pending line that names the host and model. A failed send puts the draft back in the composer. The caption under the composer repeats the host, the model or `modelo padrão`, and whether the host came from the project, the profile, or the global connection.

Each project has its own conversation. Opening the workspace for a project with no sessions creates one titled `Main Workspace Session`. Switching projects replaces the visible transcript with that project's messages and does not send the other project's history. The saved session id is used only when it belongs to the selected project; otherwise the workspace selects that project's first session and saves that layout. The composer sends `sessionId` only when the selected id is one of the sessions loaded for the open project. An empty message is rejected and does not call the host. A session id that is missing or belongs to another project does not reject the message: it is stored on this project's current session.

## Acceptance

- Desktop starts its backend and opens its own window without requiring a separately installed Bun or Node runtime.
- Directory selection is available through the desktop file picker.
- Multiple terminal tabs preserve output when switching; closing a tab stops its process; resizing changes PTY dimensions.
- Coordinator and terminal inputs identify their distinct destinations.
- Host-assisted command preparation cannot itself start a plan, run or resume.
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
