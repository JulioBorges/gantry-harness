# Roadmap

Delivery tracking for the `gantry-harness` Run orchestration adaptation. Issue status in `.scratch/` is authoritative. Regenerate the generated blocks with the official Gantry `roadmap.py waves` command.

## Progress

| | Count |
|---|---|
| Issues completed | **1 / 7** |
| Specs completed | **0 / 1** |
| Execution waves | **4** |

## Specs

| # | Spec | Status | Blocked by | Ordered after | Touches | Delivers |
|---|---|---|---|---|---|---|
| 01 | `run-orchestration` | approved | — | — | server supervisor, board, Run UI, state store | parent-process integration with the repository-pinned `gantry` CLI |

<!-- BEGIN GENERATED: spec progress -->

| # | Spec | Issues done | Waves |
|---|---|---|---|
| 01 | `run-orchestration` | 1/7 | 0–3 |

<!-- END GENERATED: spec progress -->

<!-- BEGIN GENERATED: issue checklist -->

### Wave 0 — 1/1 done

- [x] **`run-orchestration#01`** — 01: Excise the conversational orchestrator _(no blockers)_

### Wave 1 — 0/1 done

- [ ] **`run-orchestration#02`** — 02: Pack resolution, board read and board UI
  <br>↳ blocked by: run-orchestration#01

### Wave 2 — 0/1 done

- [ ] **`run-orchestration#03`** — 03: Run supervisor and Issue execution
  <br>↳ blocked by: run-orchestration#02

### Wave 3 — 0/4 done

- [ ] **`run-orchestration#04`** — 04: Plan runs
  <br>↳ blocked by: run-orchestration#03
- [ ] **`run-orchestration#05`** — 05: Wave execution and parallel Runs
  <br>↳ blocked by: run-orchestration#03
- [ ] **`run-orchestration#06`** — 06: Resume, discard and restart reattach
  <br>↳ blocked by: run-orchestration#03
- [ ] **`run-orchestration#07`** — 07: Approve, PR watching and merge-done
  <br>↳ blocked by: run-orchestration#03

<!-- END GENERATED: issue checklist -->
