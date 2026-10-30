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

When project settings reports uncommitted changes, **Limpar worktree** previews the affected files. **Guardar backup e limpar worktree** saves staged, unstaged and new files in Git stash, then refreshes the project. Ignored files remain on disk; the result shows the backup hash and its recovery command. Canceling preserves the checkout. Changes after the preview require another review; finish running or paused Runs before cleaning.

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

## Origin policy

The server does not terminate TLS and does not send `Access-Control-Allow-Origin`. The browser UI and the Electron window are same-origin with the process that serves them (`http://127.0.0.1:<port>` by default), so they do not need a cross-origin header. A page on another origin cannot read JSON responses, including project, workspace, run and artifact payloads. A simple GET may still reach the process; the browser hides the body from that other page.

Every `POST`, `PUT`, `PATCH` and `DELETE` requires both of the following, before the route runs:

- `Origin` equal to this app: `http` on the listening port, and a host that is loopback (`localhost`, `127.0.0.1`, `::1`), the concrete `--host` value, or — only when the bind is `0.0.0.0` or `::` — the IP literal in that request's `Host` header. `https`, another port, a path, `Origin: null`, a missing `Origin`, and a DNS name that is not the bind host are **403**. A name that merely resolves to the machine, including a rebinding name, is not accepted.
- `Content-Type: application/json` (parameters such as `charset` are fine). Anything else is **415**. Origin is checked first, so a cross-site `text/plain` POST is **403** and does not run the route.

The browser sets `Origin` itself. The CLI sends `Origin: http://127.0.0.1:<port>` with JSON when it dispatches to a server already running on loopback. There is no state-changing exception for a missing `Origin`.

Open the printed loopback URL. For another machine on the LAN or Tailscale, bind the address you will type: `node dist/cli.js --host 192.168.1.20 --port 7400` and open `http://192.168.1.20:7400`, or bind every interface with `--host 0.0.0.0` (or `--lan` / `--tailscale`) and open `http://<that-ip>:<port>`. Access by a DNS name that is not the host you bound is refused. To use a name, start the server with `--host` set to that name and open `http://<that-name>:<port>`.

WebSocket upgrades that present an `Origin` must use the same app origin, so another site cannot subscribe to live project and run events. Browsers always send `Origin` on that handshake. A client that omits it is not a browser; the CLI does not open a WebSocket.

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
