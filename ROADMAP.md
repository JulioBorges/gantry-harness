# Roadmap

Acompanhamento do gantry-harness. O status em `.scratch/` manda. O bloco gerado abaixo cobre só a spec `run-orchestration` e não foi regenerado; a spec `prd-alignment` está na lista manual.

Nada disso está 100% feito. `run-orchestration` entregou o supervisor e o quadro. `prd-alignment` ainda não começou: é o trabalho para o harness cumprir o PRD (comando por papel, motor antigo apagado, quadro e textos que o operador entende).

## Progresso

| | Contagem |
|---|---|
| Issues concluídas | **9 / 19** |
| Specs concluídas | **1 / 2** |
| Spec em ready-for-agent | **`prd-alignment` (0 / 10)** |

## Specs

| # | Spec | Status | Blocked by | Ordered after | Touches | Delivers |
|---|---|---|---|---|---|---|
| 01 | `run-orchestration` | approved | — | — | supervisor, quadro, registro da Run | integração com o `gantry` pinado no repositório |
| 02 | `prd-alignment` | ready-for-agent | — | `run-orchestration` | quadro, configuração de papel, textos, suíte | harness operável segundo `docs/PRD-integration.md` |

### `prd-alignment` — 0/10

Ondas pela dependência. Nada nesta lista está feito.

#### Onda 0 — prefactor, pode começar

- [ ] **`prd-alignment#01`** — Apagar o motor antigo _(sem bloqueio)_

#### Onda 1 — depois da 01

- [ ] **`prd-alignment#02`** — Suíte do pipeline portátil
  <br>↳ blocked by: prd-alignment#01
- [ ] **`prd-alignment#09`** — Terminal que não abre sozinho
  <br>↳ blocked by: prd-alignment#01

#### Onda 2

- [ ] **`prd-alignment#03`** — Comando executável do papel
  <br>↳ blocked by: prd-alignment#02
- [ ] **`prd-alignment#08`** — Sidebar legível
  <br>↳ blocked by: prd-alignment#02

#### Onda 3

- [ ] **`prd-alignment#04`** — Run pronta na coluna de Issues e erro uma vez
  <br>↳ blocked by: prd-alignment#03

#### Onda 4

- [ ] **`prd-alignment#05`** — Onda com confirmação
  <br>↳ blocked by: prd-alignment#04
- [ ] **`prd-alignment#06`** — Pausa em português
  <br>↳ blocked by: prd-alignment#04

#### Onda 5

- [ ] **`prd-alignment#07`** — Quadro que cabe na vista
  <br>↳ blocked by: prd-alignment#05, prd-alignment#06

#### Onda 6

- [ ] **`prd-alignment#10`** — Textos do operador alinhados ao PRD
  <br>↳ blocked by: prd-alignment#03, prd-alignment#07, prd-alignment#08, prd-alignment#09

## Histórico gerado — só `run-orchestration`

<!-- BEGIN GENERATED: spec progress -->

| # | Spec | Issues done | Waves |
|---|---|---|---|
| 01 | `run-orchestration` | 9/9 | 0–3 |

<!-- END GENERATED: spec progress -->

<!-- BEGIN GENERATED: issue checklist -->

### Wave 0 — 1/1 done

- [x] **`run-orchestration#01`** — 01: Excise the conversational orchestrator _(no blockers)_

### Wave 1 — 1/1 done

- [x] **`run-orchestration#02`** — 02: Pack resolution, board read and board UI
  <br>↳ blocked by: run-orchestration#01

### Wave 2 — 3/3 done

- [x] **`run-orchestration#03`** — 03: Run supervisor and Issue execution
  <br>↳ blocked by: run-orchestration#02
- [x] **`run-orchestration#08`** — 08: Restore the Files view
  <br>↳ blocked by: run-orchestration#02
- [x] **`run-orchestration#09`** — 09: Restore the standalone terminal
  <br>↳ blocked by: run-orchestration#02

### Wave 3 — 4/4 done

- [x] **`run-orchestration#04`** — 04: Plan runs
  <br>↳ blocked by: run-orchestration#03
- [x] **`run-orchestration#05`** — 05: Wave execution and parallel Runs
  <br>↳ blocked by: run-orchestration#03
- [x] **`run-orchestration#06`** — 06: Resume, discard and restart reattach
  <br>↳ blocked by: run-orchestration#03
- [x] **`run-orchestration#07`** — 07: Approve, PR watching and merge-done
  <br>↳ blocked by: run-orchestration#03

<!-- END GENERATED: issue checklist -->
