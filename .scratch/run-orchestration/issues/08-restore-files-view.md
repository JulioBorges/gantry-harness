# 08: Restore the Files view

Type: issue
Status: done
Slice: `run-orchestration#08`
Spec: `.scratch/run-orchestration/spec.md`
Created: 2026-10-19

## Parent

`run-orchestration`

## What to build

Opening a project still lands on the Issues and Specs board. A Files view, beside the board and the terminal, lists that project's files and folders again: one directory level at a time, folders expand, and a filter narrows the names. Choosing a file opens it in the file viewer with its real content. Saving from the viewer writes that content back to the file. Spec cards stay non-executable support documents.

## Acceptance criteria

- [x] The Files view sits beside the board, and a newly opened project still shows the board first.
- [x] The tree lists one directory level from the repository, expands a folder into its children, and filters by name.
- [x] Opening a file shows its current content in the viewer, and saving writes that content to the file.
- [x] An integration test covers listing, opening, and saving against a temporary project.

## Blocked by

- `run-orchestration#02`

## Comments

2026-10-19: Already present on `gantry/run-orchestration-02`. The header opens Files beside Quadro and Terminal, and `tests/file-tree.test.tsx` covers the tree, filter, open, and save. Brought across from PR #1 instead of reimplementing it.
