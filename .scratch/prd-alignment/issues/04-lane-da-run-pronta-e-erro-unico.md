# 04: Mostrar a Run pronta e o erro uma vez só

Type: issue
Status: ready-for-agent
Slice: `prd-alignment#04`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20

## Parent

`prd-alignment`

## What to build

O operador não perde a Run quando ela fica pronta. Pronta para aprovação fica na coluna de Issues, com a ação de aprovar naquele card. Aprovada, com PR ainda não done, também fica em Issues e mostra a URL. Done só quando o target diz done. Uma Run ainda em plan, implement, review ou critic continua na coluna dessa fase.

Quando o card mudaria para fora da área visível, o quadro o traz para a vista. Um erro do pack aparece uma vez, no card da Run, em português. O card da Spec não repete o erro. O arquivo da Issue não muda só porque a Run ficou pronta ou porque o setup falhou.

## Acceptance criteria

- [ ] Uma Run pronta para aprovação aparece na coluna de Issues, não numa coluna de execução, e oferece aprovar naquele card.
- [ ] Uma Run com PR aberto e Issue ainda não done permanece em Issues, mostra a URL e não entra em Done.
- [ ] Uma Run viva em implement permanece na coluna Implement. Uma Issue done no target fica em Done.
- [ ] Depois que uma Run muda para um estado cujo card nasceria fora da vista, esse card fica visível sem o operador arrastar.
- [ ] Um erro de setup do pack aparece uma vez, no card da Issue, em português, e não aparece no card da Spec.
- [ ] O arquivo da Issue no repositório temporário conserva o status de antes da Run.
- [ ] Os casos são provados no seam da suíte portátil.

## Blocked by

- `prd-alignment#03`
