# Gantry Harness

<!-- impeccable:product-schema 1 -->

## Platform

web

The React workspace is delivered in a desktop application with its own window on macOS, Windows and Linux. A browser/CLI entry remains available.

## Users

Developers operating Gantry against local repositories and installed agent harnesses.

## Product Purpose

Open a project, converse with the Gantry coordinator, prepare Gantry commands with the configured Agent Host, and operate integrated terminals without losing the current project or session.

## Operating Context

The conversation coordinates Gantry. Terminals independently run a shell or installed Codex, Claude Code, OpenCode or Antigravity CLI. They are distinct contexts and must be identified as such.

## Capabilities and Constraints

- Desktop delivery targets macOS, Windows and Linux from the start.
- Gantry command shortcuts ask the configured Agent Host to help format a command; preparation never implies execution or approval.
- Existing repository policy, per-role model choices, planning approval and execution gates remain authoritative.
- Workspace state remains local, outside repositories.
- Closing a window must have an explicit process-lifecycle policy; restarting cannot pretend terminated processes are still running.

## Brand Commitments

The supplied recording of herdr web UI is the interaction and visual reference: quiet dark workspace, compact project sidebar, session tabs, broad central surface, Chat/Terminal switching and secondary configuration.

## Evidence on Hand

- User recording: `/Users/julioborges/Documents/Screenshots/Gravação de Tela 2026-10-15 às 15.43.56.mov`.
- Current source and `.scratch/gantry-harness/spec.md`.
- User confirmed desktop delivery for all three systems and separate coordinator/terminal contexts with host-assisted Gantry command preparation.

## Product Principles

- Keep the active project, session, host and execution state understandable.
- Let the conversation and terminal own the available space.
- Show advanced setup when requested.
- Resize the actual terminal along with its viewport.
- Keep preparation, approval and execution separate actions.
