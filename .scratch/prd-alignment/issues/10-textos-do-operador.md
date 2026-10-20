# 10: Alinhar os textos ao PRD

Type: issue
Status: ready-for-agent
Slice: `prd-alignment#10`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20

## Parent

`prd-alignment`

## What to build

O primeiro texto que o operador lê descreve este produto. README, a descrição de produto, a ajuda dentro do workspace, o erro de diretório inexistente e a tela de pareamento ficam em português e batem com o PRD: o harness é o processo pai, a configuração representa o setup do Gantry e persiste modelos por papel no projeto, a interação é a pausa no quadro. Não prometem coordenador, chat, execução direta de modelos pelo harness nem instalação do pack pelo harness.

## Acceptance criteria

- [ ] README e a descrição de produto deixam de descrever conversa com coordenador, atalhos preparados por um host e execução direta de modelos pelo harness.
- [ ] Os dois descrevem o quadro, o setup completo do projeto, os modelos por papel executados pelo pipeline do Gantry, a pausa e o fato de o pack já precisar estar no repositório.
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

## Comments

### 2026-10-20 — Alinhamento à revisão de #03 e #08

Os textos explicam a seleção e persistência de modelos por papel em `.gantry/config.json`, a detecção da política existente e a aplicação do setup com prévia, sem commit automático. O Gantry mantém os comandos e as regras do pipeline. A remoção do motor antigo não remove a configuração dos modelos usados pelo Gantry.
