# File viewer dialog

Status: implemented

Opening a file uses a native modal dialog instead of an inline drawer. Markdown files default to a rendered preview; other text files default to source. Source editing and Git diffs remain available through tabs, and saving requires an explicit action.

The modal contains keyboard focus, closes with Escape or the close button, and restores focus to the opener. Content scrolls within the dialog at desktop and narrow viewport sizes.

Markdown supports headings, code, tables, checklists, heading anchors, relative file links and repository images. Raw HTML is skipped and script URLs are filtered by the Markdown renderer. Repository images use the existing API authentication and a read-only image endpoint that enforces real repository boundaries, including symlinks.

Validation covers rendering, modal dismissal, keyboard tabs, editing across views, save failures, unsafe Markdown, relative links/images, heading anchors and image route boundaries, along with the existing application integration flow.

## Verification

- 46 tests pass across 11 test files; type checking, production build and dependency audit pass.
- Browser verification confirms a native modal, Escape dismissal and restored focus. Desktop and 390px layouts fit the viewport with internal scrolling.
- Repository-relative PNG preview loaded at its original 1024px width through a local blob URL. Heading-anchor navigation was checked without saving the temporary preview edits.
- Updated macOS Apple Silicon DMG/ZIP generated; packaged startup reports `GANTRY_DESKTOP_READY`. The user's running application was left undisturbed and must be reopened to load the updated package.
- Screenshots are in `screenshots/markdown-final.png`, `markdown-desktop.png` and `markdown-mobile.png`.
