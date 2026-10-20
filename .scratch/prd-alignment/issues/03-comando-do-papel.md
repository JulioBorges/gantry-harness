# 03: Configurar e persistir o setup do Gantry no projeto

Type: issue
Status: blocked
Slice: `prd-alignment#03`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20
Revised: 2026-10-20

## Parent

`prd-alignment`

## What to build

A tela substitui a coleta e a aprovação de decisões da skill setup, sem invocar a skill nem chamar modelo: lê a política existente, oferece as decisões suportadas pelo Gantry e delega sua aplicação ao setup do pack. Os comandos e as regras do pipeline continuam no Gantry.

A seção principal é Papéis do pipeline: `plan`, `implement`, `review` e `critic`, cada um com `harness`, `model` e `effort` opcional, persistidos em `execution.roles` de `.gantry/config.json`. As demais seções guiadas cobrem checks, Git/entrega, artefatos/templates, orçamento, hooks e demais preferências suportadas pelo setup. Não basta um editor de JSON nem apenas os quatro papéis.

Ao abrir um projeto, identificar a raiz Git do checkout aberto, inclusive worktree, detectar política e skills existentes e mostrar os caminhos e a origem das skills. Não copiar política de outro checkout nem importar perfis pessoais silenciosamente. Reabrir a tela relê o disco. Ausência, JSON inválido e pack incompatível recebem diagnósticos distintos; arquivo inválido não vira configuração vazia a sobrescrever.

Antes de aplicar, mostrar uma prévia concreta das alterações na política, no bloco do Gantry em AGENTS.md e nos adapters/hooks afetados. A aplicação passa pelo script `setup.py` do Gantry, pela interface estruturada de prévia/aplicação descrita nos pré-requisitos upstream da spec, preservando campos desconhecidos e configurações não alteradas, sem commit automático. Proposta é passada por arquivo e argumentos estruturados; não se interpolam JSON no shell nem se sintetizam confirmações de overwrite no stdin. A prévia não pode ser apenas um diff fabricado que omite efeitos do setup. Sem alterações confirmadas, não escrever arquivos.

A tela não define comandos arbitrários por papel, não chama os modelos e não recria o pipeline. As escolhas do projeto não dependem de configuração global do harness. A [ADR-0007 do Gantry](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/docs/adr/0007-operator-profiles-live-outside-tracked-policy.md) define a precedência de papéis: override da Issue > override da Run > perfil pessoal > default do projeto > default confirmado do ambiente. A tela separa os defaults editáveis do projeto dos valores efetivos e suas origens. Perfis pessoais permanecem em `~/.gantry/profiles/<unit-id>/execution.json`; a resolução pode combiná-los na leitura, sem copiá-los para a política versionada.

## Acceptance criteria

- [ ] Abrir um projeto já configurado detecta `.gantry/config.json` e skills existentes e preenche a tela com a política do checkout correto, sem exigir setup inicial.
- [ ] Cadastro por subdiretório identifica a raiz Git; abrir uma worktree usa a raiz daquele checkout e não copia arquivos do checkout principal. Caminhos e origem das skills ficam visíveis.
- [ ] Ausência de política, JSON inválido e skills/pack incompatíveis são distinguíveis em português; presença de skills não é confundida com compatibilidade do comando de execução.
- [ ] Papéis do pipeline vêm em destaque, com seleção de harness, modelo e esforço opcional para plan, implement, review e critic; a persistência usa o contrato `execution.roles` do setup.
- [ ] Há seções guiadas para os campos do contrato versionado de política publicado pelo pack pinado, cobrindo papéis, checks, Git/entrega, artefatos/templates, orçamento, hooks, dashboard e Caveman. O pack fornece descritor/schema, defaults e validação semântica; o harness define apresentação e textos. Campos fora do contrato da tela são identificados como não gerenciados e preservados.
- [ ] Salvar e reabrir, inclusive após edição externa ou troca de projeto, mostra os valores atuais do projeto correto; perfis pessoais não contaminam a política salva.
- [ ] A prévia estruturada do setup mostra os efeitos reais em `.gantry/config.json`, AGENTS.md e adapters/hooks. Aplicar usa o plano aprovado e suas pré-condições; mudanças concorrentes exigem nova prévia. Cancelar não escreve; aplicação não cria commit automático. Falha parcial segue a garantia de recuperação publicada pelo pack, sem prometer atomicidade apenas por haver hash.
- [ ] A configuração salva não depende de defaults globais do harness para os modelos escolhidos. Validação, resolução e execução respeitam o contrato do Gantry, sem exigir `execution.roles.<role>.command`.
- [ ] Erros do pack/configuração oferecem explicação em português e acesso à configuração do projeto.
- [ ] A suíte portátil prova leitura, persistência via setup, releitura, preservação de campos, cancelamento sem escrita e ausência de commit automático em repositórios temporários, incluindo worktree e política inválida.
- [ ] A fixture é atualizada somente por bump para o commit upstream que entrega os contratos U1/U2/U3 da spec, seguindo `tests/fixtures/gantry-pack/README.md`, com os módulos reais necessários a setup e execução. Nenhum script da fixture é editado à mão. O fluxo setup → política gravada → execute prova o uso dos papéis configurados e os protocolos de pausa/veredito/retomada, sem campo command introduzido pelo harness.

## Blocked by

- `prd-alignment#02`
- Upstream `JulioBorges/gantry`: contratos U1 (execução), U2 (prévia/aplicação) e U3 (política versionada), descritos em [Pré-requisitos upstream](../spec.md#pré-requisitos-upstream).

A Issue permanece `blocked` até os contratos serem entregues no upstream e houver um pin verificável. Preparar o formulário não conclui a integração. Ao desbloquear, registrar o commit e a evidência de compatibilidade; presença dos scripts não basta.

## Comments

### 2026-10-20 — Revisão com o dono do produto

Substitui o desenho de comando executável por papel. A tela representa o setup completo, com prioridade para os modelos dos quatro papéis. Julio confirmou persistência no projeto, detecção do checkout aberto, prévia dos efeitos do setup, preservação da política e aplicação sem commit automático. Não inclui instalar/atualizar o pack nem reintroduzir o motor antigo de modelos do harness.

Evidência corrigida após a revisão arquitetural: o setup documenta `execution.roles` com harness/model/effort, mas `cli.py execute` no upstream pinado ainda exige `roles.<role>.command`. A fixture é uma cópia real desse executor; a divergência é interna ao pack. A UI atual mantém um draft por projeto e pode salvar o resultado combinado de defaults e perfil pessoal. Combinar na leitura efetiva é correto; gravar overlays pessoais na política compartilhada é o defeito. Ver [validação e reprodução](../architecture-review-validation.md).

A decisão de produto e os pré-requisitos estão registrados na [ADR-0001](../../../docs/adr/0001-configuracao-do-projeto-e-a-politica-do-setup.md). O nome histórico deste arquivo foi mantido para preservar referências; seu título e escopo vigentes são setup do projeto.
