# Modal de configuração — layout e rolagem

Correção visual independente da integração do setup (#03 continua bloqueada).

## Reprodução e causa

O check `bun scripts/browser-board.mjs` agora abre um projeto configurado com quatro papéis e nomes longos de modelos, abre suas configurações e verifica que os campos e botões finais podem ser alcançados. Antes da correção, falhou com `Project settings must constrain its scrolling body`: altura e conteúdo de 1478 px, sem restrição à altura do modal.

O modal do projeto é um `section`, enquanto a estrutura flex da classe compartilhada só era ativada por `[open]`. O conteúdo crescia integralmente e era cortado pelo `overflow: hidden` do modal. Uma prova aplicando somente flex corrigiu a rolagem e revelou a segunda falha: os labels tinham `display: block` porque `.project-dialog label` sobrescrevia a regra da linha dos papéis. Isso colocava rótulos e campos lado a lado e quebrava a coluna Esforço.

A correção usa a estrutura compartilhada de configurações (cabeçalho, corpo e linhas dos papéis), mantendo no projeto apenas a variante de colunas e a reserva do espaço de scrollbar: cabeçalho fixo, corpo flexível com altura mínima zero e rolagem vertical automática. As linhas alinham os labels acima de Host, Modelo e Esforço, usam colunas com limites de largura e empilham os campos no celular. Os botões finais quebram linha ou ocupam toda a largura em telas estreitas.

## Evidências e regressão

- [Antes, 951×785](screenshots/project-settings/before-951.png).
- [Depois, 951×785](screenshots/project-settings/project-settings-951.png).
- [Botões acessíveis no celular, 390×844](screenshots/project-settings/project-settings-actions-390.png).
- [Botões acessíveis em janela baixa, 844×390](screenshots/project-settings/project-settings-actions-844.png).
- [Medidas apenas do modal](screenshots/project-settings/project-settings-results.json), separadas das medidas do quadro; usa `overflow: auto` compartilhado.
- [Configurações globais desktop](screenshots/project-settings/global-settings-1280.png) e [celular](screenshots/project-settings/global-settings-390.png) também exercitadas pelo check.

O único check de browser existente agora verifica cada um dos doze controles, a posição do label acima do campo, ausência de transbordamento horizontal no modal/corpo, edição de Esforço e alcance dos botões finais mantendo o botão Fechar visível. O catálogo de modelos é uma resposta controlada no seam HTTP, sem depender de CLIs locais. Não são acionadas operações de salvar/setup.

## Regeneração e verificação

```sh
BROWSER_EVIDENCE_DIR=.scratch/prd-alignment/screenshots/project-settings bun scripts/browser-board.mjs
```

Os nomes acima são emitidos diretamente pelo runner. `before-951.png` é uma captura histórica anterior à correção e não deve ser regenerada com o código atual. A variante global é validada no mesmo runner: rótulos, campos, rolagem, botão salvar e Fechar. Resultados dos checks estão consolidados em [Validação da revisão do PR #17](pr-17-review-validation.md).
