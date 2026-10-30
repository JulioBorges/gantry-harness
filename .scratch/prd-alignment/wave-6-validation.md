# Wave 6 — validação de #04 e #08

Branch: `feat/prd-alignment-wave-6`. A #03 permanece `blocked` pelos contratos upstream U1/U2/U3; esta entrega não altera o pin nem os scripts da fixture.

## Quadro (#04)

Runs prontas para aprovação e aprovadas com PR pendente aparecem em Issues. A ação Aprovar e a URL ficam no card. A fase viva continua na coluna de execução; somente `Status: done` lido do target leva a Done. Mudanças de coluna/fase trazem o card para a área visível sem reposicionar o quadro em cada atualização.

A suíte portátil `tests/run-supervisor.test.tsx` executa o `cli.py` real da fixture em repositórios temporários: observa Implement/Review/Critic, pausa/resposta, aprovação, PR e conclusão no target. As asserções novas verificam Issues e Aprovar ao terminar, Issues com PR aberto e conteúdo integral da Issue preservado. Uma recusa real por `role-command-missing` prova diagnóstico único em português no card da Issue, sem repetição na Spec nem escrita no arquivo. Falhas de Plan também conservam um card de Issue para o diagnóstico, inclusive antes de existir uma worktree.

`tests/board-run-visibility.test.tsx` verifica transições e ausência de reposicionamento em renderizações sem mudança. O check Playwright exercita a geometria real dessas transições por snapshots de Run no seam HTTP do quadro, incluindo visibilidade em Implement, retorno a Issues e passagem a Done. Esses snapshots complementam a execução real do pack na suíte portátil.

## Sidebar (#08)

A identificação/configuração e as worktrees ficam em linhas separadas. O nome quebra linha; o caminho resumido tem uma expansão “Caminho completo”, acessível por toque e teclado. As configurações permanecem visíveis também para projetos inativos. A lista usa Runs associadas a refs de Issue, exclui o checkout principal e worktrees sem Run, e não oferece assumir o terminal. A lista de projetos e a lista de worktrees têm rolagem; os controles de navegação permanecem acessíveis.

O único runner `scripts/browser-board.mjs` usa Playwright, mantendo o comando e o registro `browser-validation` na política. Ele sobe a UI com estado isolado, dez repositórios Git temporários, nove worktrees com Run e uma worktree sem Run. Exercita seleção com lista recolhida/expandida, configuração de projeto inativo, nomes/caminhos longos, caminho completo, rolagem e ausência de transbordamento horizontal em 1280×800 e 390×844. Mantém cenários do quadro: blockers, Done, Spec, ações sem pack e releitura após edição externa. A instalação do Chromium e suas bibliotecas está documentada no README.

## Evidências visuais

As capturas anteriores usam o código de `main` antes das alterações da UI: nome truncado, caminho ausente e listagem de `main`/worktree sem Run. O cenário usa os mesmos repositórios temporários, tamanhos de viewport e expansão de worktrees. As capturas posteriores arquivadas vieram da execução completa do check Playwright na entrega original. Para regenerar e preservar essa evidência explicitamente:

```sh
BROWSER_EVIDENCE_DIR=.scratch/prd-alignment/screenshots/after bun scripts/browser-board.mjs
```

Após a revisão do PR, o check padrão usa uma pasta temporária removida ao terminar; ele não regenera esses arquivos versionados.

| Vista | Antes | Depois |
|---|---|---|
| Sidebar desktop | [1280×800](screenshots/before/sidebar-1280.png) | [1280×800](screenshots/after/sidebar-1280.png) |
| Sidebar celular | [390×844](screenshots/before/sidebar-390.png) | [390×844](screenshots/after/sidebar-390.png) |
| Run pronta desktop | — | [Card visível em Issues](screenshots/after/ready-run-1280.png) |
| Run pronta celular | — | [Card visível em Issues](screenshots/after/ready-run-390.png) |

As medidas em [results.json](screenshots/after/results.json) mostram nome com largura de 143 px no desktop e 129 px no celular, altura de 84 px nos dois tamanhos, sem erros de página. O check também afirma que a largura rolável da sidebar não ultrapassa sua largura visível.

## Checks executados

- `bun run typecheck`: passou.
- `bun run build`: passou.
- `bun run test --maxWorkers=2`: [resultado consolidado da revisão](pr-17-review-validation.md).
- `bun scripts/browser-board.mjs`: passou nos dois tamanhos de viewport, sem erros de página.
- `roadmap.py check --json`: sem drift após registrar #04 e #08.

A execução irrestrita de `bun run test` apresentou timeouts de espera em testes de UI/supervisor sob concorrência alta. A suíte usa dois workers para reduzir a disputa por recursos. Não foi alterada a semântica do terminal para contornar esses timeouts. A nova espera inicial de setup permite até cinco segundos para a leitura real do pack.

## Revisão do PR #17 (2026-10-21)

- **A1 confirmado e corrigido:** a reprodução do runner anterior alterou cinco PNGs versionados. O padrão agora usa `<tmp>/evidence`, limpo no `finally`; `BROWSER_EVIDENCE_DIR` é a única forma de preservar a saída. A comparação binária do diff de todos os arquivos versionados antes/depois do check confirmou ausência de alterações. A execução com `BROWSER_EVIDENCE_DIR=/tmp/gantry-pr17-retained-evidence` preservou seis capturas e `results.json`, sem alterar o checkout.
- **A2 corrigido:** `issueWorktreeRuns` em `boardModel.ts` centraliza a seleção usando `kind: issue`, projeto e worktree diferentes do checkout principal. Exclui Runs descartadas/recusadas e PRs fechados; PRs reabertos conservam o worktree existente e continuam aprováveis em Issues. Mantém worktrees de Runs interrompidas/com falha para recuperação. Um ref numerado não transforma uma Run de Plan em Run de Issue. Testes de modelo fixam esses casos; App apenas consome a projeção.
- **Concorrência:** o check `test` em `.gantry/config.json`, o README e o AGENTS.md agora usam `bun run test --maxWorkers=2`.
- **Cards sintéticos:** projeções de Plan carregam `synthetic: true`, identificam a Run de planejamento e não oferecem Executar issue nem entram no fallback da ação Run. A ausência de `issuePath` não fabrica um caminho de arquivo; erros de setup nesse card aparecem como falha. Issues reais do target permanecem autoritativas.
- **Runs interrompidas:** apenas `running`/`paused` usam a coluna de execução; `stopped`/`failed` voltam para Issues. A fase registrada e as ações de recuperação são preservadas. Há cobertura no modelo, na execução real do pack e no browser.
- **Fixture de browser:** `server.store.saveRun` permanece restrito à montagem do cenário isolado. As interações são feitas na UI; a suíte portátil continua cobrindo o ciclo real do pack por HTTP/WS. Não foi introduzida uma API de produção para preparar fixtures.

Resultados atuais de tipos, build, suíte, browser e roadmap estão consolidados em [Validação da revisão do PR #17](pr-17-review-validation.md).
