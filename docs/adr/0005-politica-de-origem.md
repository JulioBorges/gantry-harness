# Política de Origin, Host e CORS

Status: accepted (2026-10-30).

O servidor não termina TLS e não envia `Access-Control-Allow-Origin`. A UI do navegador e a janela Electron são da mesma origem que o processo (`http://127.0.0.1:<porta>` por omissão). Uma página noutra origem não lê o JSON. O cabeçalho `*` que existia permitia essa leitura; foi removido de todas as respostas, incluindo GET, `OPTIONS`, 404, ficheiro estático e upgrade de WebSocket.

## Regras

Todo pedido HTTP e o upgrade de WebSocket trazem um `Host` desta autoridade, na porta de escuta. A autoridade é loopback (`localhost`, `127.0.0.1`, `::1`), o valor concreto de `--host`, ou — só com bind `0.0.0.0` ou `::` — o IP literal desse `Host`. Um nome DNS que não é o host do bind é recusado, mesmo que resolva para `127.0.0.1`. Isso é DNS rebinding: o navegador ligaria ao loopback com o nome do atacante.

A resposta é **421**. O **403** fica para uma `Origin` cruzada apontada a um `Host` que este processo serve. Um `Host` malformado (vazio, porta que não é um inteiro decimal entre 0 e 65535, sufixo, IPv6 sem a forma `[endereço]:porta`) é **421** e não chega a `new URL`, que de outro modo respondia 500.

O navegador omite a porta padrão do esquema. Um `Host` sem porta corresponde a este processo só quando ele escuta em **80** ou **443**. Nas outras portas o cabeçalho tem de trazer a porta.

`POST`, `PUT`, `PATCH` e `DELETE` passam por mais duas verificações, antes da rota, nesta ordem:

1. `Origin` `http` com a mesma regra de autoridade, sem utilizador, path, query ou `null`. Ausente, `null`, `https`, outra porta ou path são **403**.
2. `Content-Type: application/json`. O resto é **415**.

O navegador define `Origin` e `Host`. Script da página não os forja para outra origem.

## Exceções

**WebSocket.** O navegador envia sempre `Origin`. Há duas regras, e as duas podem responder **403** a um token inválido.

Se a `Origin` está presente, tem de ser a origem da app. `Origin: http://<ip>:<porta>` é essa origem. Com `--host 0.0.0.0` e sem pareamento, um cliente que não é navegador envia-a e recebe os broadcasts, mesmo com um `gantry_auth_token` antigo na query. Recusar esse token fechava o socket da UI e não havia **401** que a levasse de volta ao pareamento. Um token presente e inválido, vindo de fora do loopback, num handshake que já traz `Origin`, só é **403** quando `requirePairingForRemote` está ligado. A UI apaga o token guardado e volta ao ecrã de pareamento.

A outra regra não depende do pareamento. Um handshake sem `Origin` abre só a partir de um socket loopback, ou com um token de pareamento válido no query `token` ou em `Authorization: Bearer`. Com o pareamento desligado, um handshake pela LAN sem `Origin` e com token inválido continua **403**, porque um token inválido não cumpre essa regra.

A LAN usa-se com pareamento (`--lan`, `--tailscale`, ou o equivalente). A CLI não abre WebSocket.

**CLI.** O `fetch` do Node não manda `Origin`. A CLI envia `Origin: http://127.0.0.1:<porta>` e `Content-Type: application/json` quando despacha para um servidor já em loopback. Não há exceção de estado para `Origin` ausente.

**Pareamento e `/api/health`.** Com pareamento exigido, a verificação do token corre depois de `/`, `/assets/` e `/api/health`, para a página de pareamento carregar. Um cliente remoto sem token, ou com um bearer que não é um token de pareamento atual, recebe em `/api/health` só `{ "status": "ok" }`, sem `gantryHome` nem `pid`. O loopback, e o remoto com bearer válido, continuam a ver os dois. As outras rotas de API, como `/api/projects`, respondem **401** tanto sem token como com bearer inválido. Esse HTTP não usa **403**. No WebSocket, o **403** de token inválido vem da regra de handshake sem `Origin` (fora do loopback o token tem de ser válido, com ou sem pareamento) ou, quando a `Origin` já é a da app, do pareamento ligado.

**GET com efeito.** `GET /api/workspace/state` e `GET /api/projects/:id/board` refrescam dados na leitura. A decisão de os manter está em [ADR-0004](0004-leituras-http-com-efeito.md).

## Porque não um token em todos os GET

O pareamento é o controlo do acesso remoto, não um CSRF token da página local. A página servida por este processo não apresenta token. Exigi-lo em todo GET quebrava a UI local e a ecrã de pareamento. O que fecha a leitura cruzada é a ausência de `Access-Control-Allow-Origin` mais a recusa do `Host` que não é desta autoridade.
