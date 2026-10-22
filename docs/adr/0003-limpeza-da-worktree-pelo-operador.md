# Limpeza da worktree iniciada pelo operador

Status: accepted (2026-10-22).

Julio solicitou nesta sessão uma ação para resolver o diagnóstico de árvore suja. O harness oferece **Limpar worktree** no checkout aberto: prévia dos arquivos, confirmação explícita e `git stash push --include-untracked`. A ação preserva branch, HEAD e arquivos ignorados e devolve o hash do backup com instrução de recuperação. O backup permanece no Git até ser removido pelo operador; reverter a UI não remove stashes já criados.

Esta decisão amplia a fronteira anterior do PRD e da spec, que retiraram a limpeza e seus cards do motor conversacional antigo. A nova ação é manutenção explícita do checkout registrado, fora do pipeline do pack: nunca roda automaticamente, não remove worktrees/branches e não usa reset/clean para descartar conteúdo. A entrega está em `prd-alignment#12`; a integração do setup (#03) continua bloqueada.

O supervisor coordena a exclusão entre limpeza e operações de Run, incluindo preparação, retomada, aprovação e reconciliação. Usa a identidade canônica do repositório Git para cobrir symlinks e worktrees vinculadas. A limpeza recusa Runs vivas/pausadas, conflitos, submódulos alterados e repositórios aninhados não rastreados. Prévia antiga exige nova revisão. A coordenação vale para este processo do harness; editores e outros processos externos não ficam bloqueados, e o resultado verifica novamente o estado do checkout.

Consideramos manter só a orientação de fazer commit/stash no terminal, que não resolvia a necessidade do operador na tela, e descartar alterações com reset/clean, rejeitado por perder trabalho. O stash oferece recuperação sem tornar o harness um motor paralelo de execução do Gantry.
