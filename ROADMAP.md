# Roadmap

Acompanhamento do gantry-harness. A linha `Status:` de cada Issue é a fonte da verdade. Os blocos entre `BEGIN GENERATED` e `END GENERATED` são projeção desses arquivos, regenerada por `roadmap.py`. Quando os dois divergem, a Issue vence e este arquivo está velho.

## Progresso

| | Count |
|---|---|
| Issues completed | **14 / 20** |
| Specs completed | **1 / 2** |
| Execution waves | **11** |

## Specs

Números são a linha `Map:` de cada `spec.md` (`(spec NN)`). A tabela abaixo é a camada manual do pack: *approved* quando o fatiamento foi aceito, *done* quando toda Issue da spec está `done`.

| # | Spec | Status | Blocked by | Ordered after | Touches | Delivers |
|---|---|---|---|---|---|---|
| 01 | `run-orchestration` | done | — | — | supervisor, quadro, registro da Run | integração com o `gantry` pinado no repositório |
| 02 | `prd-alignment` | approved | — | `run-orchestration` | quadro, setup do projeto, textos, suíte | harness operável segundo `docs/PRD-integration.md` |

`.scratch/gantry-harness/spec.md` está `blocked`: superada por `prd-alignment` (Julio, 2026-10-20). Não tem issues, então o pack não a projeta nem a coloca na fronteira.

A wave é uma projeção de dependências locais, não autorização para iniciar toda Issue nela. `prd-alignment#03` está `blocked` pelos contratos upstream U1/U2/U3, descritos na [spec](.scratch/prd-alignment/spec.md#pré-requisitos-upstream). #04 e #08 foram entregues na wave 6, independentemente dessa integração; [validação e evidências](.scratch/prd-alignment/wave-6-validation.md). A wave 6 permanece parcialmente concluída enquanto #03 aguarda o upstream. A #10 concentra os textos gerais; a #11 aguarda #03/#10 para documentar o setup integrado e retirar ressalvas vencidas sobre o pin.

## Progresso por spec

<!-- BEGIN GENERATED: spec progress -->

| # | Spec | Issues done | Waves |
|---|---|---|---|
| 01 | `run-orchestration` | 9/9 | 0–3 |
| 02 | `prd-alignment` | 5/11 | 4–10 |

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

### Wave 4 — 1/1 done

- [x] **`prd-alignment#01`** — 01: Apagar o motor antigo _(no blockers)_

### Wave 5 — 2/2 done

- [x] **`prd-alignment#02`** — 02: Tornar a suíte do pipeline portátil
  <br>↳ blocked by: prd-alignment#01
- [x] **`prd-alignment#09`** — 09: Não abrir o terminal sozinho
  <br>↳ blocked by: prd-alignment#01

### Wave 6 — 2/3 done

- [ ] **`prd-alignment#03`** — 03: Configurar e persistir o setup do Gantry no projeto
  <br>↳ blocked by: prd-alignment#02
- [x] **`prd-alignment#04`** — 04: Mostrar a Run pronta e o erro uma vez só
  <br>↳ blocked by: prd-alignment#02
- [x] **`prd-alignment#08`** — 08: Reorganizar a sidebar para identificar e trocar projetos
  <br>↳ blocked by: prd-alignment#02

### Wave 7 — 0/2 done

- [ ] **`prd-alignment#05`** — 05: Confirmar a onda e tirar o aprovar cego
  <br>↳ blocked by: prd-alignment#04
- [ ] **`prd-alignment#06`** — 06: Dizer a pausa em português
  <br>↳ blocked by: prd-alignment#04

### Wave 8 — 0/1 done

- [ ] **`prd-alignment#07`** — 07: Fazer o quadro caber na vista
  <br>↳ blocked by: prd-alignment#05, prd-alignment#06

### Wave 9 — 0/1 done

- [ ] **`prd-alignment#10`** — 10: Alinhar os textos gerais e traduzir o workspace
  <br>↳ blocked by: prd-alignment#07, prd-alignment#08, prd-alignment#09

### Wave 10 — 0/1 done

- [ ] **`prd-alignment#11`** — 11: Documentar o setup integrado após o pin compatível
  <br>↳ blocked by: prd-alignment#03, prd-alignment#10

<!-- END GENERATED: issue checklist -->
