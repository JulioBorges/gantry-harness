# Revisão arquitetural do PR #17 — correções consolidadas

## Decisões e fronteiras

- **A1:** o pedido explícito de Julio para disponibilizar Limpar worktree autorizou a capacidade. A ADR-0003 registra a decisão, alternativas e limites; PRD/spec distinguem a manutenção manual com stash dos cards e da limpeza automática do motor antigo. A Issue `prd-alignment#12` torna a entrega rastreável. A #03 continua bloqueada.
- **A2:** título e resumo do PR já incluíam a limpeza na revisão do estado atual. A descrição final explicita a escrita em `refs/stash`, seu efeito no checkout e a persistência dos backups após reverter o código da UI.
- **A3:** o supervisor possui a reserva por common-dir canônico. Tanto operações de Run quanto a reserva de limpeza são adquiridas antes do primeiro await. A rota HTTP só delega e traduz erros. Crianças vivas, registros suspensos e operações preparando um filho impedem a limpeza; a limpeza impede start/wave/resume/approve/discard/reconciliação. Symlinks e worktrees vinculadas compartilham a identidade. `finally` libera reservas mesmo em falha. A trava local por common-dir do escritor protege também chamadas diretas. A coordenação não bloqueia processos externos.
- **A4:** cabeçalho, corpo rolável, label/controle e breakpoint das linhas dos papéis são compartilhados. A variante de projeto define apenas colunas e reserva da scrollbar; o global define suas colunas. Os dois modais usam `overflow: auto` e passam pelo mesmo check de browser.

## Demais observações

- `git.ts` concentra execução Git e leitura `porcelain -z --untracked-files=all --ignore-submodules=none`. Diagnóstico, prévia e guarda do setup usam os mesmos arquivos/contagem. Pastas sem Git continuam abrindo no workspace; a inspeção não tenta tratá-las como checkout.
- O cliente consome `project.worktree.cleaned` e `project.setup.applied` para reler estado/quadro. A limpeza mantém sua mensagem estruturada com hash do backup, mas usa `withPending` e `pendingActions`, o mesmo controle de operações de `withFeedback`.
- `isRetiredRun` é compartilhado por overlays/sidebar. PR reaberto continua em Issues, aprovável e com o worktree existente visível. Cards sintéticos usam ausência explícita de `path`, preservando validação de caminhos reais recebidos do pack.
- Capturas usam diretamente os nomes emitidos pelo runner. `project-settings-results.json` contém só medidas dos modais. Os comandos de regeneração estão nos respectivos registros; `before-951.png` é histórico e não é sobrescrito pelo código atual.
- Contagens correntes de checks ficam somente neste arquivo e na descrição do PR. Os registros de wave, modal e limpeza apontam para esta consolidação.

## Verificações

- `bun run typecheck`: passou.
- `bun run test --maxWorkers=2`: **112 testes em 21 arquivos**, todos passaram.
- `bun run build`: passou.
- `bun scripts/browser-board.mjs`: passou em desktop/celular para quadro, sidebar, modais global/projeto e limpeza. Uma segunda janela do cliente recebeu o evento de limpeza e removeu o diagnóstico sem atualização manual.
- Status e diff binário do Git comparados antes/depois do check padrão: idênticos; nenhuma evidência versionada foi regravada automaticamente.
- `roadmap.py check --json`: sem drift; **15/21 Issues** concluídas, com #12 registrada e #03 ainda bloqueada.

Os novos testes cobrem a reserva em ambos os sentidos (limpeza versus operação de Run), liberação após falha, preparação de onda sem filho, filho vivo com registro divergente, symlink/worktree vinculada e igualdade das contagens de arquivos. Os testes existentes de abertura de pastas sem Git também passam com a leitura compartilhada.
