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

When project settings reports uncommitted changes, **Limpar worktree** previews the affected files. **Guardar backup e limpar worktree** saves staged, unstaged and new files in Git stash, then refreshes the project. Ignored files remain on disk; the result shows the backup hash and its recovery command. Canceling preserves the checkout. Changes after the preview require another review; finish running or paused Runs before cleaning. `POST /api/projects/:id/worktree/restore` with `{ backup, confirmed: true }` puts back untracked files that are still missing. It does not overwrite a path created after the backup.

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

The server does not terminate TLS and does not send `Access-Control-Allow-Origin`. The browser UI and the Electron window are same-origin with the process that serves them (`http://127.0.0.1:<port>` by default), so they do not need a cross-origin header. A page on another origin cannot read JSON responses, including project, workspace, run and artifact payloads.

Every request, including `GET`, static files and the WebSocket upgrade, must send a `Host` for this process: the listening port, and a host that is loopback (`localhost`, `127.0.0.1`, `::1`), the concrete `--host` value, or — only when the bind is `0.0.0.0` or `::` — an IP literal. A missing `Host`, another port, and a DNS name that is not the bind host are **421**. That includes a name that merely resolves to the machine, such as a rebinding name pointed at `127.0.0.1`. `Host: evil.example` does not receive project or workspace data. **421** is the misdirected-request status: the authority is not this server. **403** stays for a cross-site `Origin` aimed at a `Host` this server does serve. A malformed `Host` (empty, a port that is not a decimal integer from 0 to 65535, a suffix such as `7400.0`, or an IPv6 literal that is not `[addr]:port`) is also **421** and is never parsed as a URL. A browser omits the default port, so a `Host` without a port matches only when this process listens on **80** or **443**. Any other listen port must appear in the header.

Every `POST`, `PUT`, `PATCH` and `DELETE` also requires both of the following, before the route runs:

- `Origin` under the same host rule, as `http` with no user, path, query or `null`. `https`, another port, a path, `Origin: null` and a missing `Origin` are **403**.
- `Content-Type: application/json` (parameters such as `charset` are fine). Anything else is **415**. The `Host` is checked first, then `Origin`, so a cross-site `text/plain` POST to this host is **403** and does not run the route.

The browser sets `Origin` and `Host` itself. The CLI sends `Origin: http://127.0.0.1:<port>` with JSON when it dispatches to a server already running on loopback. There is no state-changing exception for a missing `Origin`.

Open the printed loopback URL. For another machine on the LAN or Tailscale, bind the address you will type: `node dist/cli.js --host 192.168.1.20 --port 7400` and open `http://192.168.1.20:7400`, or bind every interface with `--host 0.0.0.0` (or `--lan` / `--tailscale`) and open `http://<that-ip>:<port>`. Access by a DNS name that is not the host you bound is refused. To use a name, start the server with `--host` set to that name and open `http://<that-name>:<port>`.

A WebSocket upgrade uses the same `Host` rule. Two separate checks decide an invalid token.

When `Origin` is present, it must be the app origin. Browsers always send `Origin`. `Origin: http://<ip>:<port>` is that origin, so the origin check does not stop a non-browser LAN client. With `--host 0.0.0.0` and pairing left off, that client receives broadcasts, including when the page still has a stale `gantry_auth_token`. An invalid token on a handshake that already has `Origin` is **403** only when pairing is required (`requirePairingForRemote`) and the socket is not loopback. The UI then drops the saved token and returns to the pairing screen.

A handshake that omits `Origin` follows a second rule, whether or not pairing is on. It is accepted only from a loopback socket, or when the URL or `Authorization` header carries a valid pairing token. With pairing left off, a LAN handshake that omits `Origin` and presents an invalid token is still **403**: an invalid token does not satisfy that rule. Use the LAN with pairing (`--lan`, `--tailscale`, or an equivalent server start). The CLI does not open a WebSocket.

With pairing required, a remote `GET /api/health` without a token, or with a bearer that is not a current pairing token, returns only `{ "status": "ok" }`. It does not include `gantryHome` or `pid`. Loopback, and a remote client with a valid bearer token, still receive both. `/` and `/assets/` stay available without a token so the pairing screen can load. Other API routes, including `/api/projects`, answer **401** for a missing token and for an invalid bearer. That HTTP response is not **403**.

The rules, the WebSocket and CLI exceptions, and why reads with a side effect stay on `GET` are recorded in [ADR-0005](docs/adr/0005-politica-de-origem.md).

`GET /api/workspace/state` and `GET /api/projects/:id/board` still refresh project data as they are read. A browser on another site can trigger that refresh by targeting the real loopback host; it still cannot read the body. See [ADR-0004](docs/adr/0004-leituras-http-com-efeito.md).

## Checks

```sh
bun run typecheck
bun run test --maxWorkers=2
bun run build
bun audit --production
```

Three tests need a real `node-pty` that runs a shell and emits output. A stub that only implements the module surface fails them: `tests/desktop-experience.test.ts` (resize, then `stty size` in the buffer), `tests/terminal-settings.test.ts` (the case that runs a command in the new shell), and `tests/slice4-execution-pty-kanban-recovery.test.ts` (echo into the pane). `tests/chat-routing.test.ts` and `tests/slice5-frontend-ui.test.tsx` also call `spawn`; they fail if spawn throws, and they do not wait on shell output.

The `browser-validation` check uses Playwright against a served UI and temporary Git repositories. Install Chromium once (and its Linux system libraries if needed), then run the same entry point used by the pipeline:

```sh
bun x playwright install --with-deps chromium
bun scripts/browser-board.mjs
```

`CHROME_PATH` optionally selects an existing compatible Chromium executable. The check covers the board and project sidebar at 1280×800 and 390×844, including project switching, settings destinations, long paths, scrolling and Issue worktrees. Screenshots and measurements use a temporary directory, removed at the end of the check. Set `BROWSER_EVIDENCE_DIR=.scratch/<slug>/screenshots/after` explicitly to retain delivery evidence. The test check uses two workers to avoid UI/supervisor wait timeouts under high concurrency.
