# Leituras HTTP que também atualizam o projeto

Status: accepted (2026-10-30).

`GET /api/workspace/state` e `GET /api/projects/:id/board` não são leituras puras. A primeira pode gravar o layout quando o projeto ou a sessão ativa ainda não estão preenchidos, e as duas chamam o refresh do supervisor no projeto ativo ou no projeto do quadro. Esse refresh reconcilia Runs com o pack. A UI depende disso para mostrar o quadro ao abrir a página, sem um pedido de atualização separado.

## Risco

O `Host` de todo pedido, inclusive GET, tem de ser a autoridade deste processo. Um nome DNS que não seja o host do bind, mesmo que resolva para a máquina, recebe **421** e não chega a estas rotas. Isso fecha a leitura por DNS rebinding.

Continua possível, a partir de outra página no navegador do operador, disparar um GET simples contra o host real (`http://127.0.0.1:<porta>` ou o IP do bind). O navegador envia esse `Host`. A resposta não traz `Access-Control-Allow-Origin`, então a outra página não lê o JSON. O efeito no processo ainda acontece: layout preenchido e refresh das Runs. Não é uma mutação de Git nem de worktree, e não passa pelo guard de `Origin` porque o método é GET.

## Decisão

Estas duas rotas mantêm o refresh na leitura. Não mudam neste ajuste de CSRF. Tornar o GET puro e mover o refresh para um POST exigiria outro fluxo na UI e nos testes que abrem o quadro, e não é necessário para recusar o `Host` rebinding. O efeito que resta é o de um GET simples ao host verdadeiro, com o corpo invisível para a outra origem.

A alternativa de exigir um token também no GET foi deixada de lado: o pareamento continua a ser só para acesso remoto, e a UI local servida por este processo não apresenta token.
