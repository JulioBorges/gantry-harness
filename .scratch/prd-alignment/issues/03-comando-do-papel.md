# 03: Configurar o comando que o papel vai spawnar

Type: issue
Status: done
Slice: `prd-alignment#03`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20

## Parent

`prd-alignment`

## What to build

O operador configura, por papel, o comando executável que o processo do pack vai spawnar. Vê esse comando na configuração do projeto e na global. A do projeto vence. A tela não oferece host nem modelo como se o harness fosse executá-los.

Se o papel exigido não tem comando executável, a Issue não ganha worktree nem branch. O card explica em português e leva à configuração do projeto. Com o comando gravado e executável, a Run começa.

## Acceptance criteria

- [x] A configuração do projeto e a global gravam e mostram um comando por papel, e a do projeto vence quando as duas existem.
- [x] Não há catálogo de modelo apresentado como o que a Run executa.
- [x] Tentar executar uma Issue sem comando executável para o papel exigido não cria worktree nem branch.
- [x] Nesse caso o card da Issue explica em português e oferece abrir a configuração do projeto.
- [x] Com os comandos exigidos executáveis, executar a Issue cria a Run e o worktree.
- [x] Os dois casos são provados no seam da suíte portátil, olhando a tela e o git do repositório temporário.

## Blocked by

- `prd-alignment#02`
