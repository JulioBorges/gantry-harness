# 01: Apagar o motor antigo

Type: issue
Status: done
Slice: `prd-alignment#01`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20

## Parent

`prd-alignment`

## What to build

O operador deixa de ter um segundo jeito de conduzir o Gantry. Somem a conversa com coordenador, a preparação de comando, o plano conversacional, a rodada, o serviço de modelo, steering, takeover, a troca de modelo na recuperação, as lições e a autorização de limpeza. O kanban separado da execução some. A configuração de provedor de modelo some.

O que continua de ponta a ponta: abrir e trocar projeto, o quadro, os terminais avulsos, o visor de arquivo, as preferências de terminal e o acesso remoto por código. A navegação segue Quadro, Terminal e Arquivos.

## Acceptance criteria

- [x] Não há superfície, na tela nem na API, para conversa, preparação de comando, plano conversacional, rodada, steering, takeover, recuperação por troca de modelo, lições ou limpeza.
- [x] A configuração de provedor de modelo não aparece e não é mais lida.
- [x] Abrir projeto, quadro, terminal, arquivos, preferências de terminal e pareamento continuam utilizáveis.
- [x] A navegação oferece Quadro, Terminal e Arquivos, e não oferece uma segunda vista de execução nem uma aba de conversa.
- [x] Testes cuja única finalidade era o motor removido saem, em vez de serem reescritos contra ele.
- [x] A verificação de tipos passa e a suíte que sobrou passa.

## Blocked by

- None (can start immediately)
