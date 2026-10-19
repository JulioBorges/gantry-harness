# 09: Restore the standalone terminal

Type: issue
Status: ready-for-agent
Slice: `run-orchestration#09`
Spec: `.scratch/run-orchestration/spec.md`
Created: 2026-10-19

## Parent

`run-orchestration`

## What to build

The Terminal view runs a standalone shell for the open project again. The operator can create a pane, see its output, type into it, and have the shell follow the pane's size. Switching panes shows the selected shell. Closing a pane stops it. The project still opens on the board, and this shell is not the `execute` child of a Run.

## Acceptance criteria

- [ ] The Terminal view sits beside the board, and a newly opened project still shows the board first.
- [ ] Creating a pane starts a shell whose output is visible, and keystrokes are delivered to that shell.
- [ ] Resizing the pane updates the shell's dimensions, and switching panes shows the selected shell.
- [ ] Closing a pane stops it and removes it from the view.
- [ ] An integration test drives a real pane through output, input, and close.

## Blocked by

- `run-orchestration#02`

## Comments
