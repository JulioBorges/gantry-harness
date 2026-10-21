# Configuração do projeto é a política do setup do Gantry

Status: accepted (2026-10-20).

A tela de configuração coleta decisões e persiste a política do projeto pelo script de setup do Gantry, com `harness`, `model` e `effort` opcional em `execution.roles`. O pack mantém a semântica da política, a resolução dos papéis e a execução do pipeline; o harness mantém apresentação e supervisão do processo. A decisão evita dois contratos independentes de configuração e foi confirmada pelo dono do produto após a revisão de prd-alignment#03 e #08.

## Contexto e alternativa substituída

Substitui a decisão 1 de 2026-10-20 no PRD: configurar um comando executável por papel, com configuração do projeto sobre a global do harness. Essa alternativa correspondia ao `cli.py execute` pinado e permitiria executar o pack atual, mas transferia ao operador a montagem das invocações em vez de aproveitar as escolhas já suportadas por setup/execution.py. Gravar command e harness/model em paralelo também criaria duas representações que poderiam divergir.

A fixture não inventou esse contrato: `cli.py` é idêntico ao upstream `dc5bdd3571253af628ab629f1edcd58fa81fe2b1`, que ainda exige `execution.roles.<role>.command`. Setup e `execution.py` usam harness/model/effort. A intenção aceita exige alinhar esses caminhos no upstream; não implica compatibilidade já disponível. [Validação e reprodução](../../.scratch/prd-alignment/architecture-review-validation.md).

## Consequências

- A #03 permanece bloqueada pelos [contratos U1/U2/U3 da spec](../../.scratch/prd-alignment/spec.md#pré-requisitos-upstream): execução integrada, prévia/aplicação estruturada e contrato versionado de política. Flags e commits compatíveis ainda precisam ser publicados pelo pack. A fixture só será atualizada por bump de pin com os blobs reais, sem mudanças manuais.
- O formulário substitui a etapa conversacional de decisão, sem chamar a skill nem um modelo. O escritor é o script do setup. A prévia deve mostrar os efeitos reais em config, AGENTS.md e adapters/hooks; aplicar vincula a aprovação ao plano e às pré-condições, define concorrência/recuperação e não cria commit automaticamente. Hash sozinho não garante atomicidade entre arquivos.
- O pack publica campos, defaults e validação semântica; o harness não mantém um segundo schema independente nem recria merge e geração dos arquivos do setup. A UI gerencia o contrato da versão suportada e preserva campos desconhecidos.
- Defaults do projeto e valores efetivos são distintos. A [ADR-0007 do pack](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/docs/adr/0007-operator-profiles-live-outside-tracked-policy.md) define Issue > Run > perfil pessoal > projeto > default confirmado do ambiente. Perfis pessoais ficam fora da política versionada; combiná-los para leitura efetiva é correto, copiá-los implicitamente ao salvar defaults não é.
- Sidebar e apresentação das Runs podem evoluir sobre o pin atual, independentemente da integração do setup. A escolha e os custos da migração do check de browser para Playwright estão na [ADR-0002](0002-validacao-de-browser-com-playwright.md).
