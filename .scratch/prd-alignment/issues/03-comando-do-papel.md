# 03: Configurar e persistir o setup do Gantry no projeto

Type: issue
Status: ready-for-agent
Slice: `prd-alignment#03`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20
Revised: 2026-10-20

## Parent

`prd-alignment`

## What to build

A tela substitui a experiência de configuração da skill setup: lê a política existente, oferece as decisões suportadas pelo Gantry e delega sua aplicação ao setup do pack. Os comandos e as regras do pipeline continuam no Gantry.

A seção principal é Papéis do pipeline: `plan`, `implement`, `review` e `critic`, cada um com `harness`, `model` e `effort` opcional, persistidos em `execution.roles` de `.gantry/config.json`. As demais seções guiadas cobrem checks, Git/entrega, artefatos/templates, orçamento, hooks e demais preferências suportadas pelo setup. Não basta um editor de JSON nem apenas os quatro papéis.

Ao abrir um projeto, identificar a raiz Git do checkout aberto, inclusive worktree, detectar política e skills existentes e mostrar os caminhos e a origem das skills. Não copiar política de outro checkout nem importar perfis pessoais silenciosamente. Reabrir a tela relê o disco. Ausência, JSON inválido e pack incompatível recebem diagnósticos distintos; arquivo inválido não vira configuração vazia a sobrescrever.

Antes de aplicar, mostrar uma prévia concreta das alterações na política, no bloco do Gantry em AGENTS.md e nos adapters/hooks afetados. A aplicação passa pelo setup do Gantry, preservando campos desconhecidos e configurações não alteradas, sem commit automático. A prévia não pode ser apenas um diff fabricado que omite efeitos do setup. Sem alterações confirmadas, não escrever arquivos.

A tela não define comandos arbitrários por papel, não chama os modelos e não recria o pipeline. As escolhas do projeto não dependem de configuração global do harness. Se o Gantry suporta perfis ou outras camadas de resolução, respeitar seu contrato e mostrar divergências relevantes sem copiar esses valores implicitamente para a política versionada.

## Acceptance criteria

- [ ] Abrir um projeto já configurado detecta `.gantry/config.json` e skills existentes e preenche a tela com a política do checkout correto, sem exigir setup inicial.
- [ ] Cadastro por subdiretório identifica a raiz Git; abrir uma worktree usa a raiz daquele checkout e não copia arquivos do checkout principal. Caminhos e origem das skills ficam visíveis.
- [ ] Ausência de política, JSON inválido e skills/pack incompatíveis são distinguíveis em português; presença de skills não é confundida com compatibilidade do comando de execução.
- [ ] Papéis do pipeline vêm em destaque, com seleção de harness, modelo e esforço opcional para plan, implement, review e critic; a persistência usa o contrato `execution.roles` do setup.
- [ ] Há seções guiadas para toda a política suportada pelo setup: checks, Git/entrega, artefatos/templates, orçamento, hooks e demais preferências. Campos desconhecidos são preservados.
- [ ] Salvar e reabrir, inclusive após edição externa ou troca de projeto, mostra os valores atuais do projeto correto; perfis pessoais não contaminam a política salva.
- [ ] A prévia mostra os efeitos reais do setup em `.gantry/config.json`, AGENTS.md e adapters/hooks. Cancelar não escreve; aplicar delega ao setup e não cria commit automático.
- [ ] A configuração salva não depende de defaults globais do harness para os modelos escolhidos. Validação, resolução e execução respeitam o contrato do Gantry, sem exigir `execution.roles.<role>.command`.
- [ ] Erros do pack/configuração oferecem explicação em português e acesso à configuração do projeto.
- [ ] A suíte portátil prova leitura, persistência via setup, releitura, preservação de campos, cancelamento sem escrita e ausência de commit automático em repositórios temporários, incluindo worktree e política inválida.
- [ ] A fixture de execução é alinhada ao contrato publicado do pack; comandos artificiais da fixture não são usados para justificar requisitos do produto. A compatibilidade com o pack real é demonstrada, e indisponibilidade de `cli.py` real é registrada como lacuna, sem declarar a fixture prova dessa compatibilidade.

## Blocked by

- `prd-alignment#02`

## Comments

### 2026-10-20 — Revisão com o dono do produto

Substitui o desenho de comando executável por papel. A tela representa o setup completo, com prioridade para os modelos dos quatro papéis. Julio confirmou persistência no projeto, detecção do checkout aberto, prévia dos efeitos do setup, preservação da política e aplicação sem commit automático. Não inclui instalar/atualizar o pack nem reintroduzir o motor antigo de modelos do harness.

Evidência de investigação: o setup documenta `execution.roles` com harness/model/effort; a fixture portátil atual exige `roles.<role>.command`, divergindo desse contrato. A UI atual também mantém um draft por projeto e combina papéis de repositório e perfil pessoal. Esses comportamentos devem ser corrigidos e demonstrados pelo fluxo observável, não perpetuados como contrato.
