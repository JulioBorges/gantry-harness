# 02: Tornar a suíte do pipeline portátil

Type: issue
Status: ready-for-agent
Slice: `prd-alignment#02`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20

## Parent

`prd-alignment`

## What to build

Quem roda a suíte numa máquina sem checkout pessoal do gantry e sem pack global consegue provar o pipeline. Os testes sobem o harness contra um repositório git temporário com uma cópia do pack que viaja com a suíte. Eles observam o quadro, uma Run que pausa, a resposta devolvida ao processo e o estado pronto para aprovação.

## Acceptance criteria

- [ ] A suíte do pipeline passa sem pack global e sem um caminho absoluto da máquina de um autor.
- [ ] A cópia do pack usada no teste vem com a suíte e é pinada no repositório git temporário.
- [ ] Um teste observa a leitura do quadro a partir dessa cópia.
- [ ] Um teste observa uma Run que pausa, a escolha escrita de volta no mesmo processo, e o estado pronto para aprovação.
- [ ] O teste não afirma detalhe interno do supervisor; afirma HTTP, tela, arquivos do repositório temporário e o registro da Run fora dele.
- [ ] A verificação de tipos passa e a suíte inteira passa.

## Blocked by

- `prd-alignment#01`
