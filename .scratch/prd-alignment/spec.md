# Spec: Alinhar o harness ao PRD (`prd-alignment`)

Type: spec
Status: ready-for-agent
Map: `ROADMAP.md` (spec 02)
Created: 2026-10-20

Fonte da verdade: `docs/PRD-integration.md`, incluindo as decisões de 2026-10-20. Esta spec cobre as ondas 1 e 2 da revisão do harness. A onda 3 fica fora de escopo.

## Problema

O operador abre o gantry-harness para ver Issues e Specs e conduzir a Run só quando o pack pede uma pessoa. Hoje isso não fecha.

A tela deixa configurar host e modelo como se o harness fosse executá-los. O processo do pack não usa esse par: ele spawna o comando executável gravado no papel. Num repositório Gantry real a Run morre antes do worktree, com um código cru, repetido até no card da Spec.

Quando a Run anda, o quadro esconde o resultado. Uma Run pronta para aprovar sai da coluna que o operador está olhando. Um repositório cheio de Issues done parece vazio porque essa coluna nasce fora da vista. A pausa fala `plan-approval` e oferece `approve` / `reject`. A onda inteira cabe num botão que não diz o que vai disparar. O nome do projeto na sidebar some. O terminal abre sozinho e pinta um processo vivo como se tivesse terminado.

Por baixo, o motor antigo de conversa, plano e rodada continua alcançável, e a suíte que deveria provar o pipeline só passa na máquina de quem tem o pack num caminho pessoal. README e PRODUCT.md ainda descrevem o produto com coordenador.

## Solução

O harness fica só o processo pai e a tela da Run, como o PRD manda.

O motor antigo sai. A suíte do pipeline roda em qualquer máquina, com uma cópia do pack que viaja com os testes. Cada papel é um comando executável, visível na configuração do projeto e na global; a do projeto vence. Sem comando executável, a Run não começa e o card explica em português.

O quadro mostra onde o trabalho está: contagens, lanes vazias que não ocupam a tela, Run pronta para aprovar na coluna de Issues, erro uma vez só no card da Run, pausa em frase e verbo, onda com lista e confirmação. A sidebar lê o nome do projeto e só lista worktree de Issue em Run. O terminal não abre sozinho e não mente o estado do processo. Os textos que o operador lê batem com este PRD.

## Histórias

### Motor único e suíte que viaja

1. Como operador, quero que a única execução seja o processo filho do pack, para não existir um segundo jeito de “rodar o Gantry” que o pack não reconhece.
2. Como operador, quero abrir o workspace e não encontrar conversa, grilling, steering, takeover, troca de modelo, lições nem limpeza automática, para a tela não prometer um fluxo que o PRD aposentou.
3. Como operador, quero continuar abrindo projeto, quadro, terminal, arquivos, preferências de terminal e acesso remoto, para a remoção do motor antigo não levar o workspace junto.
4. Como quem mantém o harness, quero a suíte do pipeline verde sem um checkout pessoal do gantry, para uma máquina nova provar o mesmo contrato.

### Comando do papel

5. Como operador, quero ver e gravar, por papel, o comando executável que o pack vai spawnar, para saber o que a Run realmente dispara.
6. Como operador, quero que a configuração do projeto vença a global, para um repositório não herdar o comando de outro.
7. Como operador, quero que host e modelo deixem de aparecer como se o harness os executasse, para eu não configurar uma coisa que o processo ignora.
8. Como operador, quero que uma Issue sem comando executável para o papel exigido não ganhe worktree nem branch, para uma falha de setup não sujar o git.
9. Como operador, quero essa falha em português no card da Issue, com um caminho até a configuração do projeto, para corrigir sem ler um código de erro.

### Quadro que não esconde a Run

10. Como operador, quero a Run pronta para aprovação na coluna de Issues, com a ação de aprovar naquele card, para o fim da execução não parecer que o card sumiu.
11. Como operador, quero a Run com PR aberto e ainda não done também na coluna de Issues, mostrando a URL, para aprovação não ser confundida com done.
12. Como operador, quero done só quando o target diz done, para o quadro não antecipar o merge.
13. Como operador, quero o quadro levar à vista o card que acabou de mudar de estado, para eu não precisar caçar a Run nas colunas da direita.
14. Como operador, quero um erro do pack uma vez, no card da Run, em português, para a Spec de apoio não herdar a falha da execução.
15. Como operador, quero uma faixa com quantas Issues estão prontas, bloqueadas, em execução, esperando a mim, prontas para aprovar e done, para um repositório grande não parecer vazio.
16. Como operador, quero ativar uma dessas contagens e ir à coluna correspondente, para achar o card sem arrastar no escuro.
17. Como operador, quero colunas vazias estreitas, para as que têm card caberem na vista.
18. Como operador numa janela estreita, quero o quadro como lista com seletor de fase, para não rolar sete colunas num telefone.
19. Como operador, quero o contador ao lado de Quadro igual ao número de pausas em aberto, para saber que alguém espera resposta sem abrir cada card.

### Onda, pausa e aprovação

20. Como operador, quero executar uma Issue pelo card dela, para um trabalho não disparar os vizinhos.
21. Como operador, quero a ação de onda nomear as Issues da fronteira, na ordem da fronteira, e só enfileirar depois que eu confirmar, para um clique não começar uma leva inteira.
22. Como operador, quero uma Issue com blocker de fora dessa lista e impossível de iniciar, para a fronteira continuar valendo.
23. Como operador, quero aprovar só a partir do card da Run pronta, para não existir um aprovar que não diz qual Run.
24. Como operador, quero a pausa de aprovação do plano como uma frase e dois verbos em português, com link para a Spec e para a Issue quando o processo informar os caminhos, para eu decidir em cima do artefato.
25. Como operador, quero a pausa de orçamento esgotado como continuar com mais uma correção nesta Run ou encerrar sem merge, para a escolha não gastar o orçamento de outra Issue.
26. Como operador, quero a pausa de árvore suja como tentar de novo ou recusar, para o delta não passar por aprovação sem commit.
27. Como operador, quero que o texto devolvido ao processo seja a escolha que ele pediu, para um rótulo em português não quebrar o protocolo.
28. Como operador, quero o card em pausa dentro da vista, sem uma segunda frase dizendo que o agente espera quando as escolhas já estão ali.

### Sidebar, terminal e textos

29. Como operador, quero ler o nome do projeto na sidebar mesmo com worktrees abertas e na gaveta estreita, para saber qual repositório está ativo.
30. Como operador, quero na sidebar só a worktree de Issue que tem Run, com o ref, para o checkout principal não parecer uma Run.
31. Como operador, quero que não exista ação de assumir o lugar do agente, para takeover não voltar pela sidebar.
32. Como operador, quero que ir para Terminal só mude de vista, para um shell não nascer sem eu pedir.
33. Como operador, quero um shell novo só pelo controle de nova aba, e quero que fechar a aba encerre aquele processo, para cada aba ser uma sessão que eu abri.
34. Como operador, quero um processo ainda rodando com estado visual de em execução, não de concluído, para eu não fechar a aba achando que acabou.
35. Como operador, quero o aviso de pack ausente só no Quadro, para Terminal e Arquivos não repetirem o mesmo alerta.
36. Como operador, quero README, a descrição de produto, a ajuda, o erro de diretório inexistente e a tela de pareamento em português e fiéis a este PRD, para o primeiro texto que eu leio não falar de coordenador nem de host e modelo executados.

## Decisões de implementação

- O PRD de integração é a fonte da verdade. README e a descrição de produto não especificam comportamento; um ticket os alinha depois que a tela existir.
- O motor antigo é apagado, não escondido. Somem conversa, preparação de comando, plano conversacional, rodada, serviço de modelo, steering, takeover, recuperação por troca de modelo, lições, autorização de limpeza e o kanban de execução separado. Configuração de provedor de modelo sai junto. Ficam registro de projeto, sidebar, quadro, terminais avulsos, visor de arquivo, preferências de terminal, pareamento e o supervisor do processo filho.
- A suíte do pipeline não depende de um diretório da máquina de um autor. A cópia do pack usada no teste viaja com a suíte. O teste sobe o harness contra um repositório git temporário com essa cópia pinada.
- O contrato de papel é um comando executável por papel. A configuração do projeto cobre a global. A tela mostra esse comando. Não há catálogo de modelo apresentado como o que a Run executa.
- Antes de spawnar, se o papel exigido não tem comando executável, a Run não é criada: sem worktree, sem branch. O card da Issue explica em português e oferece abrir a configuração do projeto.
- Lane, primeira regra que casar: Spec fica em Specs. Issue done no target fica em Done. Run viva em plan, implement, review ou critic fica nessa coluna; integrate conta como critic. Todo o resto fica em Issues, inclusive ready to agent, blocked, interrompida, pronta para aprovação e aprovada com PR ainda não done. A fase escrita no arquivo da Issue não muda por causa da Run.
- Mudança de estado que tira o card da área visível rola o quadro até ele.
- Erro vindo do pack aparece uma vez, no card da Run, em português. O card da Spec não repete.
- A onda lista as Issues que a fronteira permite, na ordem da fronteira, e só enfileira depois da confirmação. Uma Issue ainda começa pelo próprio card, sem essa confirmação.
- Não há ação global de aprovar. Aprovar é do card cuja Run está pronta.
- Rótulos das pausas conhecidas, em português, sem mudar a palavra que volta para o processo: aprovação do plano (aprovar ou recusar); orçamento esgotado (continuar com mais uma correção nesta Run, ou encerrar sem merge); árvore suja (tentar de novo ou recusar). Se o processo mandar um texto, ele aparece. Se o motivo for desconhecido, o card mostra o motivo e as escolhas emitidas, ainda assim uma vez só. Não há campo de texto livre.
- Quando a pausa traz caminhos de Spec ou de Issue, o card abre esses arquivos no visor.
- A faixa do quadro conta prontas para o agente, bloqueadas, em execução, esperando o operador, prontas para aprovar e done. Ativar a contagem leva à coluna. Coluna sem card fica só o título. Abaixo da largura em que a navegação já vira gaveta, o quadro vira uma lista com seletor de fase.
- O contador na entrada Quadro é o número de Runs com pausa em aberto. Não conta alerta de decision card.
- A linha do projeto mostra o nome por inteiro, com reticências no caminho se faltar espaço. Worktrees da sidebar são só as de Issue com Run, identificadas pelo ref. O checkout principal não entra. Não há assumir terminal.
- Ir para Terminal não spawna shell. Shell novo é o controle de nova aba. Fechar a aba mata o processo. Processo rodando não usa o estado visual de concluído.
- O aviso de pack ausente fica no Quadro. Terminal e Arquivos não o repetem.
- Textos de operador (README, descrição de produto, ajuda, diretório inexistente, pareamento) em português, descrevendo comando por papel e o processo filho. Não prometem coordenador, chat, nem instalação do pack pelo harness.

## Decisões de teste

Um seam só, o mais alto que já existe: o servidor do harness mais o workspace renderizado, contra um repositório git temporário cuja cópia pinada do pack viaja com a suíte.

Um bom teste olha comportamento de fora: resposta HTTP, o que a tela mostra, arquivos e branches no repositório temporário, registro da Run fora do repositório. Não olha interno do supervisor nem parsing isolado. A palavra que volta para o processo é observável pelo próprio processo de teste, que faz o papel do pack quando o cenário precisa de uma pausa controlada; o mesmo seam também roda a cópia real do comando de board e de execute quando o cenário é o contrato publicado.

Prior art: os testes de integração do supervisor com o workspace renderizado, e os testes de tela do quadro, do terminal e dos arquivos. Eles passam a usar a cópia de pack da suíte. Testes cuja única finalidade era o motor antigo saem em vez de serem reescritos.

Não se cria seam novo de unidade para o supervisor, nem suíte de browser separada, nesta spec.

## Fora de escopo

Onda 3 da revisão, de propósito:

- Partir o cliente em módulos e apagar estado morto além do que a remoção do motor já leva.
- Mudar o intervalo com que o supervisor relê a fase no disco.
- Carregar o emulador de terminal só quando a vista de terminal abre.
- Passagem própria de contraste, foco e Escape. Um diálogo que um ticket desta spec cria ou mexe fecha com Escape se isso for preciso para o fluxo; não é uma varredura de acessibilidade.
- Política de CORS, token de pareamento e endurecimento do bind fora do loopback.
- Introduzir lint.
- Empacotar Electron e provar a janela em Windows ou Linux.

Também fora:

- Mudar o `cli.py` do pack para passar a spawnar host e modelo. O harness se adapta ao comando.
- Webhook de pull request, ou um gesto novo para o operador declarar merge à mão.
- Instalar ou atualizar o pack, e o commit que isso criaria.
- Campo de resposta livre para um papel.
- Apagar branch remoto.

## Notas

Questões abertas e a suposição que esta spec adota. O dono pode derrubar a suposição sem reabrir as duas decisões de 2026-10-20.

- Resposta pedida por um papel: só pausa emitida pelo processo, com as escolhas dele. Sem resposta livre.
- A onda dispara a fronteira inteira, mas só depois de listar e confirmar. Uma Issue começa pelo card.
- O done é lido do target. A ferramenta de PR do forge complementa quando existe. Sem ela, atualizar o quadro basta se o target já fechou. Sem webhook.
- O harness não instala o pack.
- O contador do Quadro conta pausas em aberto.

A spec `run-orchestration` continua o histórico de como o supervisor e o quadro nasceram. Onde ela ainda fala em host e modelo como o que o execute abre, vale este PRD e esta spec.
