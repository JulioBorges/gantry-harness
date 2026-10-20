# Validação da revisão arquitetural do PR #15

Investigação em 2026-10-20. PR analisado: [`5c674b2`](https://github.com/JulioBorges/gantry-harness/commit/5c674b2eba2254759168a96fe900533a52c4a698). Comentário: [revisão arquitetural](https://github.com/JulioBorges/gantry-harness/pull/15#issuecomment-6298278719).

## Fontes e limites

O `main` remoto de `JulioBorges/gantry`, consultado via `gh api repos/JulioBorges/gantry/commits/main`, aponta para `dc5bdd3571253af628ab629f1edcd58fa81fe2b1`. A árvore Git remota foi consultada; os blobs remotos de `setup.py`, `gantry-setup/SKILL.md`, ADR-0007 e `docs/role-execution.md` foram lidos via API. Seus hashes coincidem com os arquivos do checkout local usado para examinar números de linha. `common.py` e `setup_host.py` locais também coincidem com os hashes da árvore remota. As conclusões abaixo valem para esse commit, não para versões futuras do pack.

Este documento separa fatos verificados de alternativas arquiteturais. Uma recomendação do revisor não se torna requisito do upstream só por aparecer no comentário.

## A1 — Contrato de execução

**Veredito: confirmado e bloqueante para a execução integrada da #03. A conclusão anterior sobre uma exigência artificial da fixture estava errada.**

O `main` remoto consultado é o mesmo commit pinado em `tests/fixtures/gantry-pack/SOURCE.json`: `dc5bdd3571253af628ab629f1edcd58fa81fe2b1`. Download do blob remoto de `cli.py` e comparação com `cmp` confirmaram igualdade byte a byte. Ambos têm SHA-256 `e532308d5c68dc7ff2c49c0455fdf03dcfa30eeb65efae1abdd6e13b5817cae0`.

O executor lê `execution.roles.<role>.command` e exige arquivo executável. `execute_issue` verifica implement/review/critic antes de criar worktree; plan verifica os quatro papéis. Não utiliza a resolução harness/model/effort de `execution.py` nesse caminho. [Leitura do comando](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/.agents/skills/gantry/scripts/cli.py#L67-L77), [pré-validação da Issue](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/.agents/skills/gantry/scripts/cli.py#L320-L355), [plan](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/.agents/skills/gantry/scripts/cli.py#L468).

Reprodução: repositório Git temporário com branch main e commit inicial, pack copiado da fixture sem alterações, Spec/Issue válidas e política contendo os quatro papéis com harness/model. Executado `python3 <pack>/cli.py --cwd <repo> execute demo#01`:

```json
{"exitCode": 2, "stdout": {"error": {"code": "setup-invalid", "reason": "role-command-missing"}}, "branchesUnchanged": true}
```

`git worktree list --porcelain` mostrou somente o checkout inicial. Não foram invocados modelos. A reprodução confirma o pin atual; não é auditoria de todas as versões publicadas na história do pack.

Mudança proposta: preservar a decisão de produto e registrar dependência upstream para integrar `cli.py execute` com a resolução/dispatch de `execution.py`, incluindo validação e contrato de resultado/pausa do pipeline. Não basta chamar outro CLI sem compatibilizar stdout, verdicts e retomada. Atualizar a fixture somente por bump para commit upstream validado, seguindo seu README. Corrigir as referências a campo inventado/artificial no PR e retirar a prontidão de entrega integrada da #03 até os contratos estarem disponíveis. Trabalho de formulário pode ser preparado antes, sem declarar o fluxo executável concluído.

## A2 — Interface entre formulário e setup

**Veredito: lacuna de contrato confirmada; a alegação de conflito obrigatório com “não chama modelo” é exagerada.**

Fatos:

- O setup normal aceita `--config-file` e `--config`. Calcula candidatos de merge/overwrite, imprime política, conteúdo dos adapters e uma descrição do efeito sobre `AGENTS.md`; depois lê confirmação no stdin. Não há opção de saída JSON, plano estruturado ou aplicação não interativa no contrato atual. `--apply` não atende ao setup normal: o parser o rejeita fora de host-only/personal/migration. [Código do setup, linhas 167–238](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/.agents/skills/gantry/scripts/setup.py#L167-L238), [parser, linhas 242–286](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/.agents/skills/gantry/scripts/setup.py#L242-L286).
- Há proibição explícita de construir shell com JSON interpolado e de fornecer confirmação sintética de overwrite. Não é apenas inferência da revisão. [Documentação de execução, linhas 282–284](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/docs/role-execution.md#L282-L284), [skill, linhas 58–69](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/.agents/skills/gantry-setup/SKILL.md#L58-L69).
- O problema já existe na implementação atual: a prévia envia aborto pelo stdin e constrói um diff local para a política e um trecho fixo de `AGENTS.md`; a aplicação envia `m`, `o` ou `y`, e cria commit automaticamente. Portanto, a #03 precisa substituir esse caminho, não só trocar o formulário. [Prévia local](../../src/server/projectInspector.ts#L601), [aplicação local](../../src/server/projectInspector.ts#L648).
- A skill apresenta decisões, enquanto o script aplica uma proposta JSON. Um formulário determinístico pode substituir a etapa conversacional sem executar a skill nem chamar modelo. O conflito só surge se “substituir a experiência” for implementado como invocação da skill. [Etapa de decisões](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/.agents/skills/gantry-setup/SKILL.md#L8-L17), [aplicação da proposta](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/.agents/skills/gantry-setup/SKILL.md#L58-L69).

Mudança proposta:

1. Explicitar que a UI substitui a coleta/aprovação de decisões; o escritor continua sendo o script do pack, sem invocar a skill.
2. Registrar uma interface upstream de prévia/aplicação como pré-requisito. Os nomes `--preview --json` e `--apply --expect` do comentário são exemplos, não flags existentes. Passar proposta por arquivo e argumentos estruturados.
3. A prévia deve devolver arquivos afetados, conteúdos/diffs completos, modo escolhido, efeitos não automatizados e pré-condições. O apply deve aplicar a proposta aprovada e rejeitar alterações concorrentes na política, `AGENTS.md`, adapters, checkout ou versão do pack. Confirmar exatamente o plano exibido, em vez de recalculá-lo silenciosamente.
4. Não prometer atomicidade apenas porque há um hash. O hash pode vincular a aprovação ao plano, mas não impede corrida entre validação/escrita nem falha no segundo arquivo. O setup atual escreve política, adapters e `AGENTS.md` sequencialmente. A API precisa definir serialização e comportamento em falha parcial (rollback, recuperação ou outra garantia explícita). [Sequência de escrita, linhas 232–238](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/.agents/skills/gantry/scripts/setup.py#L232-L238).

## A3 — Schema, escopo e compatibilidade

**Veredito: preocupação válida; exigir um schema novo é uma solução possível, não consequência obrigatória do princípio DRY.**

O pack tem `DEFAULT_POLICY`, validadores Python, declarações JSON de capabilities e schemas JSON dos resultados dos papéis. A árvore remota não publica um schema descritivo da política de setup para gerar um formulário completo. Logo, “não existe schema no pack” seria amplo demais; o que falta é esse contrato específico. [Defaults e resolução da política](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/.agents/skills/gantry/scripts/common.py#L14-L38), [validação parcial do setup](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/.agents/skills/gantry/scripts/setup_host.py#L83-L105), [schemas de resultados](https://github.com/JulioBorges/gantry/tree/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/.agents/skills/gantry/schemas), [capabilities](https://github.com/JulioBorges/gantry/tree/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/.agents/skills/gantry/capabilities).

“Toda a política” e “demais preferências” na [#03](issues/03-comando-do-papel.md#L18) não delimitam campos ou compatibilidade. Os defaults ajudam a descobrir valores, mas não expressam todos os tipos, limites, semântica de merge/remoção e restrições de execução. Um JSON Schema estrutural também não substitui validação semântica pelo pack nem descoberta de modelos executáveis.

Opções propostas:

- Preferida para evolução: publicar no pack contrato versionado de configuração (schema/capabilities e validação), consumido pelo harness. A UI mantém apresentação e textos de produto; o pack mantém campos, defaults e regras. Compatibilidade verifica as capacidades necessárias e o protocolo, não apenas presença de `setup.py` ou número de versão.
- Alternativa viável: lista fechada de campos e versões/pins suportados nesta spec, com testes de contrato contra o pack real. Isso implica manutenção de UI por campo; não é inerentemente uma violação arquitetural. Evita bloquear tudo pela geração automática de formulários.

Em ambas: preservar campos desconhecidos sem promovê-los a campos editáveis; não materializar defaults/overlays pessoais na política versionada; distinguir “preservado mas não editável” de “inválido para o pack”. Planejar cobertura das seções aprovadas pelo usuário, sem reduzir silenciosamente o escopo aos quatro papéis.

## Perfis pessoais e defaults do projeto

A ADR-0007 já resolve a dúvida condicional da #03: perfil fica em `~/.gantry/profiles/<unit-id>/execution.json`; host explícito > perfil > host legado no repositório; papéis resolvem override de Issue > override de Run > perfil > default do projeto > default confirmado do ambiente. `setup.py --personal` deve deixar política, adapters e `AGENTS.md` intactos. [ADR-0007, linhas 9–15](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/docs/adr/0007-operator-profiles-live-outside-tracked-policy.md#L9-L15).

Combinar camadas na **leitura efetiva** é comportamento esperado. O erro é alimentar o formulário de defaults do projeto com essa combinação e salvar o resultado sem distinguir origens. A UI deve separar “padrão salvo no projeto” de “valor efetivo e origem”, mostrar divergências e conservar perfis pessoais fora da política compartilhada. O critério de independência global significa que os defaults escolhidos ficam explícitos no projeto; não pode prometer que um perfil jamais os sobrepõe, pois isso contrariaria a precedência publicada.

Há ainda uma divergência interna upstream: a ADR diz que geração de `AGENTS.md` é neutra, mas `normal_setup` ainda passa `execution.hostHarness` e possui bloco específico de Codex. Portanto, a prévia deve mostrar os efeitos reais da versão pinada; não assumir que só existirão efeitos neutros. [ADR](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/docs/adr/0007-operator-profiles-live-outside-tracked-policy.md#L15), [geração atual, linhas 27–65](https://github.com/JulioBorges/gantry/blob/dc5bdd3571253af628ab629f1edcd58fa81fe2b1/.agents/skills/gantry/scripts/setup.py#L27-L65).

## A4 — Validação de browser

**Veredito: risco de duplicação confirmado; usar Playwright não é por si uma falha arquitetural.**

[`.gantry/config.json`](../../.gantry/config.json) registra `browser-validation` como `bun scripts/browser-board.mjs`. O [script existente](../../scripts/browser-board.mjs) fala CDP diretamente, mede desktop em 1280×800 e mobile em 390×800 e valida o quadro. `package.json` não declara Playwright. O PR exige Playwright, escolhido explicitamente pelo dono do produto, mas não especifica sua integração ao check existente.

Recomendação: migrar a implementação do check de browser existente para Playwright, mantendo um único ponto de entrada e o nome `browser-validation`, preservando os cenários do quadro e acrescentando a sidebar. Declarar dependência e instalação do navegador/ambiente; a aceitação precisa executar o check, não apenas produzir screenshots manuais. Alternativa mais conservadora: manter CDP para o check e usar Playwright só na investigação, mas isso exige renegociar o requisito explícito de validação com Playwright. Não criar dois runners permanentes para os mesmos cenários.

## A5 — Registro da decisão

**Veredito: melhoria recomendada, com exagero na alegação de perda do histórico.**

O diff do PR e o Git preservam integralmente a decisão anterior; o PRD revisado também informa que ela foi substituída. Logo, a decisão não foi apagada de todo registro durável. O problema é a pouca visibilidade do motivo e das dependências técnicas para quem consulta só o documento vigente.

Recomendação: registrar ADR da decisão aceita, distinguindo intenção do produto de compatibilidade disponível. Incluir contrato anterior, por que o modelo/effort deve ser configuração do projeto, dependências upstream, perfis pessoais e migração da fixture. O PRD deve apontar para essa ADR. A ausência prévia de ADR/GLOSSARY não é, isoladamente, defeito: [docs/agents/domain.md](../../docs/agents/domain.md) permite sua criação sob demanda.

## ROADMAP e sequência de entrega

**Veredito: desatualização confirmada pelo comando oficial, sem escrita de arquivos.**

Executado `PYTHONDONTWRITEBYTECODE=1 python3 tests/fixtures/gantry-pack/scripts/roadmap.py check --json`: exit 1, `written: false`. O diff calculado troca os títulos da #03/#08 e move #08 da wave 6 para a 7 por sua nova dependência da #03. Regenerar pelo comando `roadmap.py waves`, não editar o bloco gerado manualmente.

A #08 não precisa aguardar a integração upstream para corrigir layout: separar o trabalho visual independente da aceitação de leitura/persistência da #03 evita bloquear a sidebar inteira. Revisar também dependências das demais issues para que uma integração de setup pendente não serialize trabalho sem dependência técnica real.

## Proposta de alterações

1. **Correção documental imediata:** retirar a conclusão errada sobre a fixture; registrar o contrato real do pin, pré-requisitos upstream e condição de prontidão da #03; esclarecer formulário versus skill e defaults do projeto versus valores efetivos/perfis; criar ADR; regenerar ROADMAP. Não alterar a decisão de produto para reintroduzir configuração de comandos.
2. **Contrato upstream de execução:** Gantry resolve e executa os modelos por papel dentro do pipeline, mantendo seus protocolos de pausa/veredito/retomada. O harness continua iniciando `execute` e exibindo eventos.
3. **Contrato upstream de setup:** proposta por arquivo, descriptor/schema/capabilities versionado, validação semântica pelo pack, prévia estruturada com efeitos completos e aplicação vinculada às pré-condições aprovadas. Nomes de flags são desenho proposto, não API já existente. Definir falhas parciais e concorrência explicitamente, sem prometer atomicidade apenas com hash.
4. **Adapter do harness:** só traduz eventos/formulário/protocolo do pack; não duplica merge, defaults ou geração de AGENTS/adapters. Separar leitura de política persistida da resolução efetiva. A UI é dona do layout e dos textos; o pack é dono da semântica da política.
5. **Entrega e testes:** atualizar pin e fixtures a partir do upstream; testar setup → disco → execute com papéis configurados, sem `command` introduzido pelo harness; validar cancelamento, conflito após prévia, falha parcial, campos desconhecidos e worktrees. Migrar o check de browser existente para Playwright e cobrir quadro/sidebar com um único runner.

Na etapa de investigação, os ajustes eram propostas. Após confirmação do dono do produto, foram incorporados ao PRD, à spec, às issues #02/#03/#04/#08 e à ADR-0001: #03 blocked por U1/U2/U3; #04/#08 independentes dessa integração; migração do único check de browser prevista na #08. O roadmap foi regenerado e o check passou com drift vazio. Este PR continua documental: não entrega os contratos upstream nem a migração de runner. A nota numérica de entropia do comentário não tem método reproduzível demonstrado; a priorização acima se baseia nos contratos e falhas observados, não no total +4.
