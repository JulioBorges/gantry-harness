  # PRD — gantry-harness
  ## Problema
  Rodar o Gantry hoje exige abrir um agente, chamar a skill e conduzir o pedido no chat. O operador quer carregar um repositório que já tem o pack, ver Issues e Specs, e
  executar o fluxo com interação só quando uma resposta humana é necessária. A aba de conversa não é eficiente e esta muito confusa, tanto ela como a aba Main Workspace session.
  ## Produto
  O gantry-harness é o orquestrador e a tela da Run. Ele não contém a ordem dos papéis, o veredito nem o fechamento do roadmap. Isso fica no comando `gantry` do pack instalado
  no repositório do consumidor.
  O harness é o processo pai. Para cada Run ele sobe um `gantry execute`, lê um JSON por linha e, quando o processo pede resposta, mostra a pergunta e devolve o texto na entrada
  desse mesmo processo. O quadro de Issues e Specs é lido em paralelo, por comandos determinísticos, direto dos arquivos do repositório.
  Não existe binário global. O harness chama o executável pelo caminho do pack dentro do repositório. Um diretório compartilhado, se existir, é só cache de versões baixadas.
  Quem executa é a cópia pinada no repo.
  ## Carregar um projeto
  O operador abre um diretório de código. Se o pack está instalado, o quadro aparece. Se não está, o harness não oferece execução.
  A fase inicial de todo card de Issue e de Spec é **ready to agent**. A fase mostrada durante a Run existe só no harness. O arquivo da Issue e o da Spec não mudam quando a Run
  começa, quando o setup falha, nem quando o plan é recusado.
  ## Quadro
  O quadro mostra Issues e Specs do repositório. A Spec não é executável. Ela é documento de apoio da Issue.
  O operador seleciona um card de Issue e manda executar. O harness cria o registro local da Run e chama o `execute` com ela. Executar a onda enfileira uma Run por Issue da
  onda, na ordem da fronteira.
  Uma Issue com blocker em aberto não inicia. O card continua no quadro, sem worktree e sem Run. Quando o blocker entra no `target` como done, o card fica disponível.
  ## Runs em paralelo
  Cada Issue tem a própria Run e o próprio worktree, no branch da Issue. O harness sobe um `gantry execute` por Run, cada um com a própria entrada e saída. Várias Runs andam ao
  mesmo tempo quando nenhuma depende da outra.
  O registro da Run fica no harness, fora do PR. Depois de reiniciar, o PR é reencontrado pelo nome do branch da Issue. O done é lido do `target`.
  ## Plan
  Plan é outra ação, para um trabalho que ainda não tem Spec nem Issue. O operador informa o slug. O `execute` reserva o próximo número e cria o branch já com o nome definitivo.
  Quando o plan grava a Spec e a Issue, a Run pausa no harness. Aprovar continua no mesmo worktree para implement, review e critic. Recusar apaga o worktree e o branch, descarta
  a Run e não deixa card.
  Se o plan terminar com arquivos soltos, o harness mostra a pausa depois que o `execute` já tentou de novo uma vez. O operador tenta outra vez ou recusa. Isso não gasta
  correção. O delta pode ser na Spec ou na Issue, e precisa virar commit antes da aprovação do plan.
  ## Execução
  O harness não escolhe o próximo papel e não chama modelo por conta própria. O `execute` abre, sem janela, o harness e o modelo configurados em `execution.roles` para aquele
  papel. A configuração do projeto cobre a global. O operador permanece na tela do gantry-harness.
  Pausas que o harness precisa mostrar:
  - aprovação do plan
  - resposta pedida por um papel
  - orçamento esgotado: continuar com mais uma correção, só nessa Run, ou encerrar sem merge
  - plan que continuou com árvore suja: tentar de novo ou recusar
  Encerrar sem merge deixa a Run interrompida, com worktree e branch locais. O card não volta para ready to agent. Retomar segue no mesmo worktree. Com orçamento zerado, retomar
  só reabre a pausa. Com orçamento restante, o `execute` continua do último papel incompleto.
  Descartar apaga o worktree e o branch local. Se a Issue nasceu nesse plan e ainda não está no `target`, não sobra card. Se a Issue já estava no `target`, o card volta para
  ready to agent.
  Quando review e critic passam, o `execute` termina. A Run fica pronta. Retomar essa Run não chama agente. O harness oferece o comando de aprovação.
  ## Aprovação e PR
  O comando de aprovação roda no mesmo worktree. Se o commit de fechamento ainda não existe, ele marca a Issue e o roadmap como feitos, faz push e abre o PR. Se esse commit já
  está no branch, o comando só abre o PR.
  Abrir o PR encerra a espera da execução e guarda a URL. O card continua fora de done. O harness monitora os cards aprovados que ainda não estão done.
  Quando o PR é mergeado, o card fica done porque o `target` já contém o fechamento. O harness apaga o worktree e o branch local e não grava mais nada. O branch remoto segue a
  regra do forge.
  Quando o PR é fechado sem merge, a Run termina sem done. O card continua visível, fora de ready to agent. O worktree local sai. Reabrir o PR repete só a aprovação, sem agente.
  ## Fora de escopo
  O gantry-harness não implementa a ordem dos papéis, o orçamento, os checks, os micro commits, o texto do fechamento nem a regra de blocker. Não embute Claude Code nem Codex.
  Não instala o pack fora do repositório do consumidor. Não abre uma segunda alteração só para atualizar o roadmap depois do merge.