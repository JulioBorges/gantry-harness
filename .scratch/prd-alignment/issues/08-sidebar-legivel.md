# 08: Ler o projeto na sidebar

Type: issue
Status: ready-for-agent
Slice: `prd-alignment#08`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20

## Parent

`prd-alignment`

## What to build

O operador identifica o repositório ativo. O nome do projeto continua legível com a lista de worktrees aberta e na gaveta estreita; o que encolhe, se faltar espaço, é o caminho. A lista mostra só worktree de Issue que tem Run, com o ref da Issue. O checkout principal não aparece. Não há ação de assumir o terminal no lugar do agente.

## Acceptance criteria

- [ ] Com a lista de worktrees aberta, o nome do projeto segue legível na sidebar larga e na gaveta estreita.
- [ ] O checkout principal do repositório não entra na lista.
- [ ] Uma Issue com Run mostra a worktree dela, identificada pelo ref.
- [ ] Não há controle de assumir o terminal a partir dessa lista.
- [ ] Trocar de projeto e abrir a configuração daquele projeto continuam funcionando.
- [ ] Os casos são provados no seam da suíte portátil.

## Blocked by

- `prd-alignment#02`
