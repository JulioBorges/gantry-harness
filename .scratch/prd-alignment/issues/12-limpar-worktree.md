# 12: Limpar a worktree por decisão do operador

Type: issue
Status: done
Slice: `prd-alignment#12`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-22

## Parent

`prd-alignment`

## What to build

Extensão de escopo solicitada por Julio em 2026-10-22: transformar o diagnóstico de árvore suja em uma ação de manutenção do checkout. A [ADR-0003](../../../docs/adr/0003-limpeza-da-worktree-pelo-operador.md) registra os limites e a diferença para os cards de limpeza do motor antigo, que continuam removidos.

## Acceptance criteria

- [x] O diagnóstico oferece Limpar worktree, com prévia do checkout e arquivos, cancelamento sem escrita e confirmação explícita.
- [x] A confirmação guarda staged/unstaged/novos em Git stash, preserva arquivos ignorados, branch e HEAD e fornece o hash e o comando de recuperação.
- [x] A prévia se vincula ao checkout, HEAD, índice e conteúdo; alterações posteriores exigem nova revisão.
- [x] O supervisor impede limpeza durante operações de Run e impede início, onda, retomada, aprovação e reconciliação durante a limpeza, inclusive por symlink e worktree vinculada. A reserva é liberada mesmo em falha.
- [x] Conflitos, submódulos alterados e repositórios aninhados são recusados antes do stash.
- [x] Diagnóstico, prévia e setup compartilham a mesma leitura de estado Git; o resultado atualiza os clientes e exibe o backup sem executar limpeza automática.
- [x] Testes com Git real cobrem recuperação, confirmação, concorrência e isolamento; browser cobre preview/cancelar/confirmar em desktop/celular.

## Blocked by

- `prd-alignment#08`

## Comments

A aprovação do escopo vem do pedido explícito de Julio nesta conversa para disponibilizar Limpar worktree e do pedido posterior para aplicar as correções da revisão arquitetural. Não desbloqueia contratos upstream nem altera a fixture do pack.
