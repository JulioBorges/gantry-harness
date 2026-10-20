# PRD — gantry-harness

## Problema

Rodar o Gantry hoje exige abrir um agente, chamar a skill e conduzir o pedido no chat. O operador quer carregar um repositório que já tem o pack, ver Issues e Specs, e executar o fluxo com interação só quando uma resposta humana é necessária. A aba de conversa não é eficiente e está muito confusa, tanto ela como a aba Main Workspace session.

## Produto

O gantry-harness é o orquestrador e a tela da Run. Ele não contém a ordem dos papéis, o veredito nem o fechamento do roadmap. Isso fica no comando `gantry` do pack instalado no repositório do consumidor.

O harness é o processo pai. Para cada Run ele sobe um `gantry execute`, lê um JSON por linha e, quando o processo pede resposta, mostra a pergunta e devolve o texto na entrada desse mesmo processo. O quadro de Issues e Specs é lido em paralelo, por comandos determinísticos, direto dos arquivos do repositório.

Não existe binário global. O harness chama o executável pelo caminho do pack dentro do repositório. Um diretório compartilhado, se existir, é só cache de versões baixadas. Quem executa é a cópia pinada no repo.

Este arquivo é a fonte da verdade do produto. README e PRODUCT.md estão desatualizados em relação a ele; alinhá-los é trabalho de implementação, não uma segunda especificação.

## Carregar um projeto

O operador abre um diretório de código. Se o pack está instalado, o quadro aparece. Se não está, o harness não oferece execução.

A fase inicial de todo card de Issue e de Spec é **ready to agent**. A fase mostrada durante a Run existe só no harness. O arquivo da Issue e o da Spec não mudam quando a Run começa, quando o setup falha, nem quando o plan é recusado.

## Quadro

O quadro mostra Issues e Specs do repositório. A Spec não é executável. Ela é documento de apoio da Issue.

O operador seleciona um card de Issue e manda executar. O harness cria o registro local da Run e chama o `execute` com ela. Executar a onda enfileira uma Run por Issue da onda, na ordem da fronteira.

Uma Issue com blocker em aberto não inicia. O card continua no quadro, sem worktree e sem Run. Quando o blocker entra no `target` como done, o card fica disponível.

## Runs em paralelo

Cada Issue tem a própria Run e o próprio worktree, no branch da Issue. O harness sobe um `gantry execute` por Run, cada um com a própria entrada e saída. Várias Runs andam ao mesmo tempo quando nenhuma depende da outra.

O registro da Run fica no harness, fora do PR. Depois de reiniciar, o PR é reencontrado pelo nome do branch da Issue. O done é lido do `target`.

## Plan

Plan é outra ação, para um trabalho que ainda não tem Spec nem Issue. O operador informa o slug. O `execute` reserva o próximo número e cria o branch já com o nome definitivo. Quando o plan grava a Spec e a Issue, a Run pausa no harness. Aprovar continua no mesmo worktree para implement, review e critic. Recusar apaga o worktree e o branch, descarta a Run e não deixa card.

Se o plan terminar com arquivos soltos, o harness mostra a pausa depois que o `execute` já tentou de novo uma vez. O operador tenta outra vez ou recusa. Isso não gasta correção. O delta pode ser na Spec ou na Issue, e precisa virar commit antes da aprovação do plan.

## Execução

O harness não escolhe o próximo papel e não chama modelo por conta própria. O `execute` abre, sem janela, o comando executável gravado para aquele papel. A configuração do projeto cobre a global. O operador permanece na tela do gantry-harness.

O contrato de cada papel é esse comando, não um host nem um modelo. A tela configura e mostra o comando que o processo do pack vai spawnar. Se o comando exigido não está gravado ou não é executável, a Run não começa.

Pausas que o harness precisa mostrar:

- aprovação do plan
- resposta pedida por um papel (questão aberta; ver abaixo)
- orçamento esgotado: continuar com mais uma correção, só nessa Run, ou encerrar sem merge
- plan que continuou com árvore suja: tentar de novo ou recusar

Encerrar sem merge deixa a Run interrompida, com worktree e branch locais. O card não volta para ready to agent. Retomar segue no mesmo worktree. Com orçamento zerado, retomar só reabre a pausa. Com orçamento restante, o `execute` continua do último papel incompleto.

Descartar apaga o worktree e o branch local. Se a Issue nasceu nesse plan e ainda não está no `target`, não sobra card. Se a Issue já estava no `target`, o card volta para ready to agent.

Quando review e critic passam, o `execute` termina. A Run fica pronta. Retomar essa Run não chama agente. O harness oferece o comando de aprovação.

## Aprovação e PR

O comando de aprovação roda no mesmo worktree. Se o commit de fechamento ainda não existe, ele marca a Issue e o roadmap como feitos, faz push e abre o PR. Se esse commit já está no branch, o comando só abre o PR.

Abrir o PR encerra a espera da execução e guarda a URL. O card continua fora de done. O harness monitora os cards aprovados que ainda não estão done.

Quando o PR é mergeado, o card fica done porque o `target` já contém o fechamento. O harness apaga o worktree e o branch local e não grava mais nada. O branch remoto segue a regra do forge.

Quando o PR é fechado sem merge, a Run termina sem done. O card continua visível, fora de ready to agent. O worktree local sai. Reabrir o PR repete só a aprovação, sem agente.

## Fora de escopo

O gantry-harness não implementa a ordem dos papéis, o orçamento, os checks, os micro commits, o texto do fechamento nem a regra de blocker. Não embute Claude Code nem Codex. Não chama modelo. Não instala o pack fora do repositório do consumidor. Não abre uma segunda alteração só para atualizar o roadmap depois do merge.

O motor antigo em TypeScript — plano conversacional, rodada, serviço de modelo, preparação de comando, steering, takeover, grilling, cards de limpeza e o kanban separado da execução — não faz parte do produto. O único caminho de execução é o processo filho do pack.

## Decisões — 2026-10-20

Julio, dono do produto, fechou duas perguntas da revisão do harness. O texto de Execução acima já reflete a primeira. O que mudou:

1. **Contrato de papel = comando executável.** A ideia é o harness rodar o `cli.py` do gantry por trás. A tela para de apresentar host e modelo como se fossem executados e passa a configurar e mostrar o comando que esse processo vai spawnar. A configuração do projeto cobre a global. Sem comando executável para o papel exigido, a Run não começa e o quadro explica o motivo.
2. **O motor TypeScript antigo pode ser apagado.** Saem o plano conversacional, a rodada, o serviço de modelo, as rotas de plano, de run e de preparação de comando, steering, takeover, grilling, cards de limpeza e o kanban antigo. Não ficam atrás de uma flag.

Fonte da verdade: este PRD. README e PRODUCT.md descrevem o produto antigo e serão alinhados por um ticket, não por uma leitura paralela.

## Questões abertas

Não há resposta do dono. A suposição é o que a spec adota até ele corrigir.

1. **Resposta pedida por um papel.** O pack publicado pausa com motivo e escolhas (`plan-approval`, orçamento esgotado, árvore suja). Não emite pergunta aberta. **Suposição:** o harness só mostra pausa que o processo filho emite. Se vier um texto junto da pausa, o card mostra esse texto. As ações são só as escolhas emitidas. Não há campo de resposta livre.
2. **O que a ação de onda dispara.** O PRD manda enfileirar uma Run por Issue da fronteira. A tela hoje usa um rótulo que não diz isso. **Suposição:** a onda continua existindo, lista as Issues na ordem da fronteira e só começa depois de confirmação. Executar uma Issue continua no card dela. Não há ação de aprovar que não nomeie a Run.
3. **Quem observa o PR.** **Suposição:** o done continua sendo lido do `target`. Quando a ferramenta de PR do forge está disponível, o harness também lê se o PR foi mergeado ou fechado sem merge. Sem essa ferramenta, atualizar o quadro ainda move o card para done se o `target` já tem o fechamento. Sem webhook e sem um gesto novo de “marcar merge” nesta leva.
4. **Instalar ou atualizar o pack pela tela.** O PRD diz que o harness não instala o pack fora do repositório do consumidor e que o operador abre um repositório que já tem o pack. **Suposição:** esta leva não oferece instalar nem atualizar o pack, e não cria commit de skills. Sem pack, o quadro explica e não executa.
5. **O que o contador do Quadro conta.** **Suposição:** conta Runs com pausa esperando o operador. Alertas nascidos de decision card do motor antigo somem com ele.
