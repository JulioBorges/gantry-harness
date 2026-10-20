# 06: Dizer a pausa em português

Type: issue
Status: ready-for-agent
Slice: `prd-alignment#06`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20

## Parent

`prd-alignment`

## What to build

O operador entende a pausa sem ler o código do protocolo. Aprovação do plano, orçamento esgotado e árvore suja aparecem como frase e verbos em português. Se o processo mandou caminhos da Spec e da Issue, o card abre esses arquivos. A palavra que volta para o processo é a escolha que ele emitiu, não o rótulo traduzido.

O card em pausa fica na vista. Não há uma segunda frase dizendo que o agente espera resposta quando as escolhas já estão no card. Não há campo de texto livre.

## Acceptance criteria

- [ ] A pausa de aprovação do plano mostra uma frase de aprovação e as ações de aprovar e recusar, em português, e abre a Spec e a Issue quando o processo informa os caminhos.
- [ ] A pausa de orçamento esgotado oferece continuar com mais uma correção nesta Run ou encerrar sem merge.
- [ ] A pausa de árvore suja oferece tentar de novo ou recusar.
- [ ] O processo de teste recebe a escolha emitida (`approve`, `reject`, `continue`, `stop` ou `try-again`), não a frase portuguesa.
- [ ] Com as escolhas visíveis, o card não mostra também um aviso genérico de que o agente espera resposta.
- [ ] Ao entrar em pausa, o card fica dentro da área visível.
- [ ] Não há campo de resposta livre.
- [ ] Os três motivos são provados no seam da suíte portátil.

## Blocked by

- `prd-alignment#04`
