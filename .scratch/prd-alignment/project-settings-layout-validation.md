# Modal de configuração — layout e rolagem

Correção visual independente da integração do setup (#03 continua bloqueada).

## Reprodução e causa

O check `bun scripts/browser-board.mjs` agora abre um projeto configurado com quatro papéis e nomes longos de modelos, abre suas configurações e verifica que os campos e botões finais podem ser alcançados. Antes da correção, falhou com `Project settings must constrain its scrolling body`: altura e conteúdo de 1478 px, sem restrição à altura do modal.

O modal do projeto é um `section`, enquanto a estrutura flex da classe compartilhada só era ativada por `[open]`. O conteúdo crescia integralmente e era cortado pelo `overflow: hidden` do modal. Uma prova aplicando somente flex corrigiu a rolagem e revelou a segunda falha: os labels tinham `display: block` porque `.project-dialog label` sobrescrevia a regra da linha dos papéis. Isso colocava rótulos e campos lado a lado e quebrava a coluna Esforço.

A correção usa classes específicas para o modal e seu conteúdo: cabeçalho fixo, corpo flexível com altura mínima zero e rolagem vertical visível. As linhas alinham os labels acima de Host, Modelo e Esforço, usam colunas com limites de largura e empilham os campos no celular. Os botões finais quebram linha ou ocupam toda a largura em telas estreitas.

## Evidências e regressão

- [Antes, 951×785](screenshots/project-settings/before-951.png).
- [Depois, 951×785](screenshots/project-settings/after-951.png).
- [Botões acessíveis no celular, 390×844](screenshots/project-settings/actions-390.png).
- [Botões acessíveis em janela baixa, 844×390](screenshots/project-settings/actions-844.png).
- [Medidas do browser](screenshots/project-settings/results.json): corpo com 636/939 px, 241/960 px e 708/2015 px de altura visível/conteúdo, respectivamente, com `overflow-y: scroll`.

O único check de browser existente agora verifica cada um dos doze controles, a posição do label acima do campo, ausência de transbordamento horizontal no modal/corpo, edição de Esforço e alcance dos botões finais mantendo o botão Fechar visível. O catálogo de modelos é uma resposta controlada no seam HTTP, sem depender de CLIs locais. Não são acionadas operações de salvar/setup.

## Verificação

- `bun run typecheck`: passou.
- `bun run build`: passou.
- `bun scripts/browser-board.mjs`: passou, incluindo as três dimensões do modal e os cenários anteriores do quadro/sidebar. O padrão continua usando artefatos temporários; as imagens deste registro foram preservadas explicitamente via `BROWSER_EVIDENCE_DIR`.
- `bun run test --maxWorkers=2`: 96 testes passaram; o teste de aprovação/PR teve timeout na espera de `run-error-feat#01`. A repetição isolada `bun x vitest run tests/run-supervisor.test.tsx -t 'handles Approve'` passou. Nenhuma regra de aprovação foi alterada por esta correção de layout.
