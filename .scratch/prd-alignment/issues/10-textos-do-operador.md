# 10: Alinhar os textos ao PRD

Type: issue
Status: ready-for-agent
Slice: `prd-alignment#10`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20

## Parent

`prd-alignment`

## What to build

O primeiro texto que o operador lê descreve este produto. README, a descrição de produto, a ajuda dentro do workspace, o erro de diretório inexistente e a tela de pareamento ficam em português e batem com o PRD: o harness é o processo pai, o papel é um comando executável, a interação é a pausa no quadro. Não prometem coordenador, chat, host e modelo executados, nem instalação do pack pelo harness.

## Acceptance criteria

- [ ] README e a descrição de produto deixam de descrever conversa com coordenador, atalhos preparados por um host e execução de host e modelo.
- [ ] Os dois descrevem o quadro, o comando por papel, a pausa e o fato de o pack já precisar estar no repositório.
- [ ] A ajuda do workspace diz o mesmo, em português, e não manda restaurar um agente como se isso fosse o fluxo da Run.
- [ ] Abrir um diretório que não existe mostra o erro em português.
- [ ] A tela de pareamento remoto está em português.
- [ ] Nenhum desses textos oferece instalar ou atualizar o pack.
- [ ] A verificação de tipos passa e a suíte passa.

## Blocked by

- `prd-alignment#03`
- `prd-alignment#07`
- `prd-alignment#08`
- `prd-alignment#09`
