# 02: Tornar a suíte do pipeline portátil

Type: issue
Status: done
Slice: `prd-alignment#02`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20

## Parent

`prd-alignment`

## What to build

Quem roda a suíte numa máquina sem checkout pessoal do gantry e sem pack global consegue provar o pipeline. Os testes sobem o harness contra um repositório git temporário com uma cópia do pack que viaja com a suíte. Eles observam o quadro, uma Run que pausa, a resposta devolvida ao processo e o estado pronto para aprovação.

## Acceptance criteria

- [x] A suíte do pipeline passa sem pack global e sem um caminho absoluto da máquina de um autor.
- [x] A cópia do pack usada no teste vem com a suíte e é pinada no repositório git temporário.
- [x] Um teste observa a leitura do quadro a partir dessa cópia.
- [x] Um teste observa uma Run que pausa, a escolha escrita de volta no mesmo processo, e o estado pronto para aprovação.
- [x] O teste não afirma detalhe interno do supervisor; afirma HTTP, tela, arquivos do repositório temporário e o registro da Run fora dele.
- [x] A verificação de tipos passa e a suíte inteira passa.

## Blocked by

- `prd-alignment#01`

## Comments

### 2026-10-20 — Lacuna de contrato identificada na revisão de #03

O status done registra a entrega de portabilidade original. A fixture `tests/fixtures/gantry-pack/scripts/cli.py` exige `execution.roles.<role>.command`, enquanto o setup/execution inspecionado usa harness/model/effort e monta a invocação no Gantry. Portabilidade não demonstra fidelidade a esse contrato. A #03 inclui corrigir a fixture e validar persistência/execução contra o contrato do pack, sem usar essa exigência artificial como requisito de produto. Na investigação, o pack global não tinha `scripts/cli.py`; sua execução real não foi validada.
