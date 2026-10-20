# 10: Alinhar os textos gerais e traduzir o workspace

Type: issue
Status: ready-for-agent
Slice: `prd-alignment#10`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20

## Parent

`prd-alignment`

## What to build

O primeiro texto que o operador lê descreve este produto. README, a descrição de produto, a ajuda dentro do workspace, o erro de diretório inexistente e a tela de pareamento ficam em português e batem com o PRD: o harness é o processo pai e a interação é a pausa no quadro. Esta entrega cobre o produto já disponível: navegação, execução/pausas, terminal, arquivos, ajuda, erros e pareamento. Não prometem coordenador, chat, execução direta de modelos pelo harness nem instalação do pack pelo harness.

## Acceptance criteria

- [ ] README e a descrição de produto deixam de descrever conversa com coordenador, atalhos preparados por um host e execução direta de modelos pelo harness.
- [ ] Os dois descrevem quadro, execução pelo pack, pausas e a exigência de pack no repositório, com o comportamento atual e sem anunciar o setup integrado de #03 como disponível.
- [ ] A ajuda do workspace diz o mesmo, em português, e não manda restaurar um agente como se isso fosse o fluxo da Run.
- [ ] Abrir um diretório que não existe mostra o erro em português.
- [ ] A tela de pareamento remoto está em português.
- [ ] Nenhum desses textos oferece instalar ou atualizar o pack.
- [ ] A verificação de tipos passa e a suíte passa.

## Blocked by

- `prd-alignment#07`
- `prd-alignment#08`
- `prd-alignment#09`

## Comments

### 2026-10-20 — Alinhamento à revisão de #03 e #08

Os textos explicam a seleção e persistência de modelos por papel em `.gantry/config.json`, a detecção da política existente e a aplicação do setup com prévia, sem commit automático. O Gantry mantém os comandos e as regras do pipeline. A remoção do motor antigo não remove a configuração dos modelos usados pelo Gantry.

### 2026-10-20 — Textos independentes do setup

A revisão acima passa a ser entregue em duas partes. Esta #10 não depende mais da #03: traduções e textos gerais seguem após #07/#08/#09. Os textos específicos do setup, a evidência do pin compatível e a retirada da ressalva sobre o pin antigo ficam na [#11](11-textos-do-setup-integrado.md), dependente de #03 e #10.
