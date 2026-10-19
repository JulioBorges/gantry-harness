# System terminal and consolidated settings

Status: implemented

Terminal and + Terminal open a system shell at the active project directory. They never automatically start the coordinator host. Operators may invoke any CLI, resume command, or custom arguments in that shell. Existing agent takeover endpoints remain available for explicit recovery actions.

One sidebar Settings button opens a native modal with Terminal, AI connection, Project and Remote access tabs. Opening settings leaves the workspace and PTY processes intact; Escape closes the modal and focus returns to the opener. Tabs support arrow/Home/End navigation.

Terminal preferences persist in the local harness database independently of provider secrets and repository policy: font family, integer font size 8–40 px and shell. Font changes update the mounted xterm and refit its PTY. Shell changes affect newly opened PTYs only.

Native choices come from the server platform: Linux bash/sh; macOS zsh/bash/sh; Windows CMD/Windows PowerShell/PowerShell 7. The system default remains selectable. Installed executables are checked; unavailable options are disabled, and invalid or unavailable selections return errors without replacing saved settings.

Validation: regression UI and API tests, actual PTY command execution and persistence after server restart, full suite, typecheck, production build, and responsive browser checks on macOS. Native Linux/Windows process execution requires verification on those systems.

## Verification results

- `bun run typecheck`: passed.
- `bun run test`: 68 tests passed across 13 files.
- `bun run build`: passed.
- `bun audit --production`: no advisories; `bun audit --audit-level=high`: passed. Full development dependency audit reports the existing moderate sprintf-js advisory through Electron tooling.
- Browser checks: 1440×900, 1280×720, 768×640 and 390×700; no horizontal overflow, working native focus containment/Escape, shell keyboard input, font refit without replacing the terminal, saved shell on new tabs and preferences restored after page reload.
- Screenshots: `screenshots/settings-1440.png`, `screenshots/settings-390.png`, `screenshots/project.png`, `screenshots/terminal.png`.


## Installed system font selection

The Terminal tab uses a native select populated by the current device's Local Font Access API. Families are trimmed, deduplicated across font styles, and sorted alphabetically. No static suggested font list is presented as installed. A generic monospace option and any unavailable saved configuration remain selectable. Selecting a family updates the preview and saves the existing fontFamily preference format.

The list can be refreshed after fonts are installed. Access denial, unavailable browser support and empty results are visible, with retry when supported. Font access remains on the rendering device rather than querying fonts from a remote server. No new dependency or desktop permission override is required.

## Host model selection

Every model control in Settings is a `<select>` filled from the models the selected agent reports. A host never offers another host's models.

- **Project.** Each role has its own host (`opencode`, `claude-code`, `codex`, `antigravity`). Its model options come from that host's discovery catalog. Changing the host clears the current model. Save rejects a model that is not in the loaded catalog for that host.
- **AI connection, CLI.** The coordinator model lists the models of the selected CLI host. `claude` discovers as `claude-code` and `agy` as `antigravity`. An empty choice means the host default. Switching host restores the model last saved for the new host, or clears it. The choice is stored per host in `providers.cli.modelsByHost`.
- **AI connection, API.** The coordinator model stays the provider's own model identifier. There is no local agent catalog for that mode.

The catalog is `GET /api/projects/:id/discovery?harness=<host>` and loads when the tab is open. Discovery failure is shown on the control and does not leave a free-text model in place.

Validation includes mocked family deduplication/sorting, saved unavailable font preservation, list refresh, denied permission retry and unsupported browsers, plus actual Electron and Chromium checks against installed macOS font families.


System font verification: 237 installed macOS families matched the selector exactly in the real Electron runtime. Selecting Fira Code updated the preview, survived a list refresh and persisted after reload. Chromium also listed local fonts, restored the saved choice, fit at 390 px and offered retry when font access was denied (including empty-array denial responses). Screenshots: `screenshots/system-fonts-desktop.png` and `screenshots/system-fonts-mobile.png`.
