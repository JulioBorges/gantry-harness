# 05: Confirmar a onda e tirar o aprovar cego

Type: issue
Status: ready-for-agent
Slice: `prd-alignment#05`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20

## Parent

`prd-alignment`

## What to build

O operador executa uma Issue pelo card dela, e isso não dispara as outras. A ação de onda mostra as Issues que a fronteira permite, na ordem da fronteira, e só enfileira uma Run por Issue depois da confirmação. Issue com blocker não entra na lista e não inicia. Não existe ação de aprovar que não diga qual Run; aprovar continua no card da Run pronta.

## Acceptance criteria

- [ ] Executar pelo card de uma Issue cria só a Run daquela Issue.
- [ ] A ação de onda lista as Issues elegíveis na ordem da fronteira e não cria Run nenhuma antes da confirmação.
- [ ] Confirmar a lista cria uma Run por Issue listada, nessa ordem, cada uma com o próprio worktree.
- [ ] Uma Issue com blocker aberto não aparece na lista e não ganha Run nem worktree.
- [ ] Cancelar a confirmação não cria Run.
- [ ] Não há controle de aprovar que não identifique a Run. O card pronto para aprovação ainda oferece aprovar.
- [ ] Os casos são provados no seam da suíte portátil.

## Blocked by

- `prd-alignment#04`
