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

As capturas anteriores usam o código de `main` antes das alterações da UI: nome truncado, caminho ausente e listagem de `main`/worktree sem Run. O cenário usa os mesmos repositórios temporários, tamanhos de viewport e expansão de worktrees. As capturas posteriores vêm da execução completa do check Playwright.

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
- `bun run test --maxWorkers=2`: 87 testes, 20 arquivos, todos passaram.
- `bun scripts/browser-board.mjs`: passou nos dois tamanhos de viewport, sem erros de página.
- `roadmap.py check --json`: sem drift após registrar #04 e #08.

A execução irrestrita de `bun run test` apresentou timeouts de espera em testes de UI/supervisor sob concorrência alta. Os dois arquivos alterados passaram separadamente (12 testes); a suíte completa passou com dois workers. Não foi alterada a semântica do terminal para contornar esses timeouts. A nova espera inicial de setup permite até cinco segundos para a leitura real do pack.
