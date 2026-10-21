# Spec: Alinhar o harness ao PRD (`prd-alignment`)

Type: spec
Status: ready-for-agent
Map: `ROADMAP.md` (spec 02)
Created: 2026-10-20

Fonte da verdade: `docs/PRD-integration.md`, incluindo a revisão de setup e sidebar confirmada em 2026-10-20. Esta spec cobre as ondas 1 e 2 da revisão do harness. A onda 3 fica fora de escopo.

## Problema

O operador abre o gantry-harness para ver Issues e Specs e conduzir a Run só quando o pack pede uma pessoa. Hoje isso não fecha.

A tela de configuração deve representar o setup do Gantry e persistir a política do projeto. O desenho anterior desta spec exigia comandos executáveis por papel e removia a seleção de modelos. Isso reflete o `cli.py execute` pinado, mas diverge da seleção harness/model/effort do setup e de `execution.py`. A decisão de produto é unificar os contratos no Gantry antes de entregar a integração da tela. A leitura também precisa reconhecer configuração e skills existentes no checkout aberto, atualizar valores ao reabrir e separar perfis pessoais da política versionada. Falhas do pack precisam de explicação em português, sem repetição no card da Spec.

Quando a Run anda, o quadro esconde o resultado. Uma Run pronta para aprovar sai da coluna que o operador está olhando. Um repositório cheio de Issues done parece vazio porque essa coluna nasce fora da vista. A pausa fala `plan-approval` e oferece `approve` / `reject`. A onda inteira cabe num botão que não diz o que vai disparar. O nome do projeto na sidebar some. O terminal abre sozinho e pinta um processo vivo como se tivesse terminado.

Por baixo, o motor antigo de conversa, plano e rodada continua alcançável, e a suíte que deveria provar o pipeline só passa na máquina de quem tem o pack num caminho pessoal. README e PRODUCT.md ainda descrevem o produto com coordenador.

## Solução

O harness fica só o processo pai e a tela da Run, como o PRD manda.

O motor antigo sai. A suíte do pipeline roda em qualquer máquina, com uma cópia do pack que viaja com os testes. A configuração oferece a política completa suportada pelo setup, com modelos por papel em destaque, persistida em `.gantry/config.json`. O pack mantém os comandos e as regras do pipeline. A tela lê o checkout aberto, mostra a origem dos arquivos e skills, apresenta prévia e delega a aplicação ao setup sem commit automático.

O quadro mostra onde o trabalho está: contagens, lanes vazias que não ocupam a tela, Run pronta para aprovar na coluna de Issues, erro uma vez só no card da Run, pausa em frase e verbo, onda com lista e confirmação. A sidebar lê o nome do projeto e só lista worktree de Issue em Run. O terminal não abre sozinho e não mente o estado do processo. Os textos que o operador lê batem com este PRD.

## Histórias

### Motor único e suíte que viaja

1. Como operador, quero que a única execução seja o processo filho do pack, para não existir um segundo jeito de “rodar o Gantry” que o pack não reconhece.
2. Como operador, quero abrir o workspace e não encontrar conversa, grilling, steering, takeover, troca de modelo, lições nem limpeza automática, para a tela não prometer um fluxo que o PRD aposentou.
3. Como operador, quero continuar abrindo projeto, quadro, terminal, arquivos, preferências de terminal e acesso remoto, para a remoção do motor antigo não levar o workspace junto.
4. Como quem mantém o harness, quero a suíte do pipeline verde sem um checkout pessoal do gantry, para uma máquina nova provar o mesmo contrato.

### Setup do projeto

5. Como operador, quero selecionar harness, modelo e esforço opcional de plan, implement, review e critic e persistir essas escolhas em `execution.roles` de `.gantry/config.json`, para o pipeline do Gantry usá-las.
6. Como operador, quero detectar política e skills existentes na raiz Git do checkout aberto, com caminhos e origem visíveis, para não reconfigurar um projeto já preparado nem usar silenciosamente outro checkout.
7. Como operador, quero editar em seções guiadas a política do contrato versionado do pack pinado, com papéis em destaque e preservação de campos desconhecidos.
8. Como operador, quero revisar os efeitos em configuração, AGENTS.md e adapters/hooks antes de delegar a aplicação ao setup, sem commit automático nem cópia implícita de perfil pessoal.
9. Como operador, quero recarregar os valores ao reabrir a tela e distinguir ausência, política inválida e pack incompatível, com explicação em português e acesso à configuração.

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

29. Como operador, quero nome, caminho e acesso às configurações numa linha própria e worktrees abaixo, para selecionar e trocar projetos sem informações ou controles ocultos em desktop e celular.
30. Como operador, quero na sidebar só a worktree de Issue que tem Run, com o ref, para o checkout principal não parecer uma Run.
31. Como operador, quero que não exista ação de assumir o lugar do agente, para takeover não voltar pela sidebar.
32. Como operador, quero que ir para Terminal só mude de vista, para um shell não nascer sem eu pedir.
33. Como operador, quero um shell novo só pelo controle de nova aba, e quero que fechar a aba encerre aquele processo, para cada aba ser uma sessão que eu abri.
34. Como operador, quero um processo ainda rodando com estado visual de em execução, não de concluído, para eu não fechar a aba achando que acabou.
35. Como operador, quero o aviso de pack ausente só no Quadro, para Terminal e Arquivos não repetirem o mesmo alerta.
36. Como operador, quero README, a descrição de produto, a ajuda, o erro de diretório inexistente e a tela de pareamento em português e fiéis a este PRD, para o primeiro texto que eu leio não falar de coordenador nem de execução direta de modelos pelo harness.

## Decisões de implementação

- O PRD de integração é a fonte da verdade. README e a descrição de produto não especificam comportamento; um ticket os alinha depois que a tela existir.
- O motor antigo é apagado, não escondido. Somem conversa, preparação de comando, plano conversacional, rodada, serviço de modelo, steering, takeover, recuperação por troca de modelo, lições, autorização de limpeza e o kanban de execução separado. Configuração de provedor do motor antigo sai junto; seleção de modelos para o pipeline do Gantry permanece no setup do projeto. Ficam registro de projeto, sidebar, quadro, terminais avulsos, visor de arquivo, preferências de terminal, pareamento e o supervisor do processo filho.
- A suíte do pipeline não depende de um diretório da máquina de um autor. A cópia do pack usada no teste viaja com a suíte. O teste sobe o harness contra um repositório git temporário com essa cópia pinada.
- A tela configura a política completa suportada pelo setup. Papéis do pipeline vêm primeiro: plan, implement, review e critic com harness, model e effort opcional em `execution.roles` de `.gantry/config.json`. O Gantry resolve e executa o pipeline; não se introduzem comandos arbitrários por papel.
- O checkout aberto define a raiz de leitura e gravação, inclusive quando é worktree. Configuração ausente, inválida e skills/pack incompatíveis têm diagnósticos distintos. Caminhos e origem ficam visíveis; a tela relê o disco ao reabrir. Não se importa política de outro checkout nem perfil pessoal implicitamente.
- Checks, Git/entrega, artefatos/templates, orçamento, hooks, dashboard e Caveman têm seções guiadas conforme o contrato de política da versão pinada. O pack fornece descritor/schema, defaults e validação semântica; o harness mantém apresentação e textos. Campos fora do contrato gerenciado pela tela são sinalizados e preservados. A prévia cobre os efeitos reais em config, AGENTS.md e adapters/hooks. Aplicar delega ao script do setup, sem commit automático nem invocação da skill conversacional.
- Validação e precedência de execução pertencem ao Gantry. A fixture atual é cópia do `cli.py` real no commit `dc5bdd3571253af628ab629f1edcd58fa81fe2b1` e exige `command`; setup/execution.py usam harness/model/effort. A divergência exige correção upstream, não edição manual da fixture. A #03 fica blocked até existir um pin compatível. Erros explicam em português e levam à configuração do projeto.
- Conforme a ADR-0007 do pack, a resolução efetiva de papéis é Issue > Run > perfil pessoal > default do projeto > default confirmado do ambiente. A tela edita defaults do projeto separadamente de valores efetivos/origens; perfis ficam fora do repositório e não são promovidos implicitamente para a política compartilhada.
- Lane, primeira regra que casar: Spec fica em Specs. Issue done no target fica em Done. Run viva em plan, implement, review ou critic fica nessa coluna; integrate conta como critic. Todo o resto fica em Issues, inclusive ready to agent, blocked, interrompida, pronta para aprovação e aprovada com PR ainda não done. A fase escrita no arquivo da Issue não muda por causa da Run.
- Mudança de estado que tira o card da área visível rola o quadro até ele.
- Erro vindo do pack aparece uma vez, no card da Run, em português. O card da Spec não repete.
- A onda lista as Issues que a fronteira permite, na ordem da fronteira, e só enfileira depois da confirmação. Uma Issue ainda começa pelo próprio card, sem essa confirmação.
- Não há ação global de aprovar. Aprovar é do card cuja Run está pronta.
- Rótulos das pausas conhecidas, em português, sem mudar a palavra que volta para o processo: aprovação do plano (aprovar ou recusar); orçamento esgotado (continuar com mais uma correção nesta Run, ou encerrar sem merge); árvore suja (tentar de novo ou recusar). Se o processo mandar um texto, ele aparece. Se o motivo for desconhecido, o card mostra o motivo e as escolhas emitidas, ainda assim uma vez só. Não há campo de texto livre.
- Quando a pausa traz caminhos de Spec ou de Issue, o card abre esses arquivos no visor.
- A faixa do quadro conta prontas para o agente, bloqueadas, em execução, esperando o operador, prontas para aprovar e done. Ativar a contagem leva à coluna. Coluna sem card fica só o título. Abaixo da largura em que a navegação já vira gaveta, o quadro vira uma lista com seletor de fase.
- O contador na entrada Quadro é o número de Runs com pausa em aberto. Não conta alerta de decision card.
- Identificação e configurações do projeto ficam numa linha própria; worktrees ficam abaixo. Nome pode quebrar linha; caminho pode usar reticências com acesso ao valor completo. Selecionar projeto ou expandir worktrees não oculta informações nem controles. Worktrees são só as de Issue com Run, identificadas pelo ref. O checkout principal não entra. Não há assumir terminal. A experiência é validada em desktop e celular pelo check existente `browser-validation`, cuja implementação CDP será migrada para Playwright, preservando seus cenários e ponto de entrada, conforme a [ADR-0002](../../docs/adr/0002-validacao-de-browser-com-playwright.md).
- Ir para Terminal não spawna shell. Shell novo é o controle de nova aba. Fechar a aba mata o processo. Processo rodando não usa o estado visual de concluído.
- O aviso de pack ausente fica no Quadro. Terminal e Arquivos não o repetem.
- Textos gerais de operador (README, descrição de produto, ajuda, diretório inexistente, pareamento) em português, descrevendo o produto disponível e o processo filho, sem anunciar o setup integrado (#10). Os textos do setup integrado vêm depois do pin compatível (#11). Não prometem coordenador, chat, nem instalação do pack pelo harness.

## Pré-requisitos upstream

A [ADR-0001](../../docs/adr/0001-configuracao-do-projeto-e-a-politica-do-setup.md) registra a decisão aceita e suas alternativas. A #03 está `blocked` aguardando os contratos abaixo em `JulioBorges/gantry`; as mudanças no pack são pré-requisitos externos, não implementação deste repositório. Não há flags novas nem commit compatível publicados por este PR.

- **U1 — Execução integrada:** `cli.py execute` deve resolver e executar papéis por harness/model/effort através da camada `execution.py`, respeitando precedência, validação, protocolos de pausa/veredito, stdout do pipeline e retomada. Não adicionar tradução paralela para command no harness.
- **U2 — Proposta, prévia e aplicação:** o script do setup deve aceitar proposta JSON por arquivo, invocada por argumentos estruturados (`--config-file` já existe). Deve publicar prévia legível por máquina com arquivos afetados e efeitos completos em política, AGENTS.md e adapters/hooks, modo de merge/overwrite e orientações manuais. Aplicação não interativa deve se vincular ao plano aprovado e às pré-condições dos arquivos, checkout e versão do pack, rejeitando mudanças concorrentes com pedido de nova prévia. Definir serialização e comportamento em falha parcial/recuperação; um hash sozinho não garante atomicidade. Não fabricar diff no harness, interpolar JSON no shell nem sintetizar confirmação de overwrite via stdin. Nomes futuros de flags/protocolo serão definidos upstream.
- **U3 — Contrato da política:** o pack pinado deve publicar descritor/schema e identificação de versão/capacidades para os campos gerenciados, defaults e validação semântica. Abrange papéis, artefatos e issue tracker, templates, checks, Git/entrega, orçamento, hooks, dashboard e Caveman. Compatibilidade é verificar esse contrato e U1/U2, não só a existência dos scripts. A tela preserva campos não gerenciados e não reimplementa regras do pack.

Na consulta de 2026-10-20 não foi identificado item específico de U1/U2/U3 no GitHub do pack nem no tracker local consultado. Esses contratos continuam requisitos externos sem ticket upstream vinculado; não confundir trabalho relacionado de dispatch/perfis com sua entrega. Antes de desbloquear #03, vincular o artefato upstream correspondente e sua evidência.

Registrar os commits upstream quando entregues e atualizar a fixture apenas pelos blobs desses commits, seguindo seu README, incluindo dependências reais do setup/dispatch. Provar setup → política no disco → execute sem command gerado pelo harness antes de desbloquear/concluir a integração da #03. O setup atual é interativo; o harness atual fabrica parte da prévia e injeta respostas, caminho que deverá ser substituído, não adotado como protocolo.

A #08 entrega layout e destino da navegação, sem depender da persistência da #03. A #04 trata eventos de Run já suportados pelo pin atual e depende da #02, não da nova tela de setup. A aceitação da configuração completa fica na #03. A #10 entrega textos gerais e traduções sem depender do setup; a #11 entrega os textos específicos de configuração após #03/#10 e remove as ressalvas vencidas sobre o pin antigo junto à evidência do novo pin.

## Decisões de teste

Um seam só, o mais alto que já existe: o servidor do harness mais o workspace renderizado, contra um repositório git temporário cuja cópia pinada do pack viaja com a suíte.

Um bom teste olha comportamento de fora: resposta HTTP, o que a tela mostra, arquivos e branches no repositório temporário, registro da Run fora do repositório. Não olha interno do supervisor nem parsing isolado. A palavra que volta para o processo é observável pelo próprio processo de teste, que faz o papel do pack quando o cenário precisa de uma pausa controlada; o mesmo seam também roda a cópia real do comando de board e de execute quando o cenário é o contrato publicado.

Prior art: os testes de integração do supervisor com o workspace renderizado, e os testes de tela do quadro, do terminal e dos arquivos. Eles passam a usar a cópia de pack da suíte. Testes cuja única finalidade era o motor antigo saem em vez de serem reescritos.

Não se cria seam novo de unidade para o supervisor. A #08 migra `scripts/browser-board.mjs` de CDP direto para Playwright, mantendo o comando `bun scripts/browser-board.mjs` e seu registro como check `browser-validation` em `.gantry/config.json`. Declarar dependência e instalação do navegador/ambiente; preservar cenários do quadro e incluir seleção/troca de projetos, expansão de worktrees, nomes/caminhos longos, rolagem e destino da configuração em 1280×800 e 390×844. Não manter runners de browser paralelos. A #03 testa os módulos reais de setup/execução no novo pin, releitura, preservação da política, perfis separados, cancelamento sem escrita, conflito após prévia e recuperação de falha parcial segundo o contrato do pack.

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

- Reimplementar no harness os comandos, a ordem ou as regras de execução do Gantry. A tela configura a política; o pack executa.
- Implementar U1/U2/U3 neste repositório ou alterar scripts da fixture à mão. Mudar cli.py/execução e o setup no pack é pré-requisito upstream da #03, não entrega deste PR.
- Webhook de pull request, ou um gesto novo para o operador declarar merge à mão.
- Instalar ou atualizar o pack, e o commit que isso criaria.
- Campo de resposta livre para um papel.
- Apagar branch remoto.

## Notas

Questões abertas e a suposição que esta spec adota. As decisões de setup e sidebar de 2026-10-20 estão incorporadas; as suposições abaixo permanecem onde não foram revistas.

- Resposta pedida por um papel: só pausa emitida pelo processo, com as escolhas dele. Sem resposta livre.
- A onda dispara a fronteira inteira, mas só depois de listar e confirmar. Uma Issue começa pelo card.
- O done é lido do target. A ferramenta de PR do forge complementa quando existe. Sem ela, atualizar o quadro basta se o target já fechou. Sem webhook.
- O harness não instala o pack.
- O contador do Quadro conta pausas em aberto.

A spec `run-orchestration` continua o histórico de como o supervisor e o quadro nasceram. Para configuração e execução, valem este PRD e esta spec revisados: o setup persiste as escolhas de modelos por papel e o pipeline do Gantry controla a execução.
