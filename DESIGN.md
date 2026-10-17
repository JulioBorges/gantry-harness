---
name: Gantry Harness workspace
description: A quiet desktop workspace following the supplied herdr reference.
colors:
  primary: "#e6ad52"
  background: "#171715"
  sidebar: "#131311"
  surface: "#20201d"
  border: "#34342f"
  text: "#edede8"
  muted: "#aaa99f"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
rounded:
  sm: "6px"
  md: "12px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
---

# Design System: Gantry Harness

## Overview

Follow the user-supplied herdr recording. The interface serves long developer sessions: a quiet dark canvas, restrained amber actions, compact navigation and a generous working surface. This is an operational workspace.

## Colors

Use the primary accent for the active view and important actions. Distinguish working, waiting, blocked and finished through both words and status marks. Keep ordinary surfaces neutral and readable.

## Typography

Use system UI typography for controls and conversation. Reserve monospace for terminal output, commands, paths and diffs. Use sentence case.

## Layout

Use a compact sidebar and a flexible main column with `min-width: 0` and `min-height: 0`. The project and session header remain compact. Conversation has a readable measure; terminal occupies all available space. Settings and execution details are secondary views.

Below 760px, navigation becomes a dismissible drawer. Never stack a large sidebar above the working surface. At narrow sizes, tabs scroll locally, controls wrap, and the composer remains reachable. Validate at 390, 768, 1280 and 1440px widths and short desktop heights.

## Elevation & Depth

Separate surfaces with tonal changes and thin borders. Use an offset shadow for dialogs and drawers. No decorative grid or glowing controls.

## Shapes

Use gently rounded controls and slightly larger composer corners. Project and session rows are flat, compact navigation elements.

## Components

- Sidebar: project rows, session navigation and settings at the bottom.
- Header: current context, navigation toggle and Chat/Terminal selector.
- Composer: message entry, Gantry command shortcuts and configured host context.
- Terminal tabs: launcher, running/exited state, switching and close control.
- Execution view: current phase, pending decisions, issue and run identity.
- Command preparation: show the host's proposed command for review before dispatch.
- File viewer: native modal dialog with focus containment, Escape dismissal and scrollable content. Markdown defaults to a rendered preview; source and diff remain available as tabs.

## Do's and Don'ts

- Do preserve working functions and explicit execution approvals.
- Do label coordinator conversation separately from standalone CLI sessions.
- Do keep focus visible and all navigation keyboard accessible.
- Don't display onboarding instructions permanently above the terminal.
- Don't report a process as online without runtime evidence.
