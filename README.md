# Gantry Harness

Desktop workspace for local Gantry projects, with a coordinator conversation, host-assisted command preparation, integrated CLI terminals and execution tracking.

## Run locally

Use Node.js 22.12+ and Bun to install and build:

```sh
bun install
bun start
```

`bun start` builds the app and opens its desktop window. Open a repository using **Abrir projeto** and the native folder picker. Role hosts and models live in **Configurações → Projeto**.

The packaged desktop app includes its runtime; end users do not need Bun or Node to launch it. Git, installed agent CLIs and Python 3 for Gantry's workflow scripts remain external prerequisites for the corresponding operations.

## Workspace

- **Conversa** talks to the Gantry coordinator. `/plan`, `/run` and `/setup` shortcuts ask the configured host to prepare a command. Review the proposal before starting it. Preparing a command never approves or executes a plan.
- **Terminal** opens the system shell in the project directory. Run any CLI yourself, including session restore commands and custom flags. Use **+ Terminal** to add shell tabs. Closing a tab terminates that terminal process.
- **Quadro** shows repository Issues and Specs, and moves an Issue through Plan, Implement, Review, Critic and Done while a run is active.
- Files open in a modal viewer. Markdown opens in a rendered preview with tables, checklists, repository images and heading links; **Código** and **Diff** remain available, with explicit saving of edits.
- **Configurações** opens **Terminal**, **Gantry** and **Acesso remoto**. **Gantry** is the optional global configuration. Each project row has a settings button for that repository's host and roles, which override the global configuration.
- **Terminal** preferences persist locally: font family, font size (8–40 px) and shell. The font selector lists installed families on the current device, alphabetically and without style duplicates, with a live preview and list refresh. In browser mode, listing requires Local Font Access support and permission; saved preferences are preserved if access is unavailable. Choices follow the server OS: Bash/Sh on Linux, Zsh/Bash/Sh on macOS, and CMD/Windows PowerShell/PowerShell 7 on Windows. Unavailable shells are disabled. Font changes apply to open terminals; shell changes apply to new tabs.

Use the navigation button or Cmd/Ctrl+B to collapse the sidebar. Narrow windows use a dismissible navigation drawer. Closing the desktop application stops its local server and terminals. Projects and conversation history remain under `~/.gantry/harness`; processes are not reported as surviving a restart.

Installing/updating Gantry skills and saving repository configuration create local commits on the current branch. Start with a clean Git worktree and a configured Git identity. Existing changes must be committed or stashed first. Personal profiles remain local and do not create commits. No push or PR is created by setup.

## Build packages

```sh
bun run build
bun run desktop:pack                 # Unpacked application for the current OS
bun run desktop:dist -- --publish never
```

Package configuration provides macOS DMG/ZIP, Windows NSIS and Linux AppImage/DEB targets. Build on each target OS for its native modules; `.github/workflows/desktop.yml` supplies that matrix and uploads artifacts without publishing a release. Signing credentials must be supplied separately for signed distribution.

The current implementation was locally verified on macOS. Windows and Linux installer/runtime verification must run on those systems; the build matrix has not been executed remotely from this workspace.

## Browser/CLI entry

```sh
bun run start:web
node dist/cli.js --port 7400
```

Open the printed loopback URL. Build emits the `gantry-harness` CLI entry as well as the browser assets, which resolve relative to the installed application instead of the selected repository.

## Checks

```sh
bun run typecheck
bun run test --maxWorkers=2
bun run build
bun audit --production
```

The `browser-validation` check uses Playwright against a served UI and temporary Git repositories. Install Chromium once (and its Linux system libraries if needed), then run the same entry point used by the pipeline:

```sh
bun x playwright install --with-deps chromium
bun scripts/browser-board.mjs
```

`CHROME_PATH` optionally selects an existing compatible Chromium executable. The check covers the board and project sidebar at 1280×800 and 390×844, including project switching, settings destinations, long paths, scrolling and Issue worktrees. Screenshots and measurements use a temporary directory, removed at the end of the check. Set `BROWSER_EVIDENCE_DIR=.scratch/<slug>/screenshots/after` explicitly to retain delivery evidence. The test check uses two workers to avoid UI/supervisor wait timeouts under high concurrency.
