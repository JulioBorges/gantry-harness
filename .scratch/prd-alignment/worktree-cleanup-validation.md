# Limpar worktree do projeto

A configuração do projeto agora oferece **Limpar worktree** no diagnóstico de árvore suja. A ação prepara uma lista de arquivos e mostra o checkout exato. Cancelar não escreve; a confirmação **Guardar backup e limpar worktree** executa `git stash push --include-untracked`, preservando um backup recuperável e mantendo a branch e o HEAD. Arquivos ignorados permanecem no disco. A resposta inclui o hash do stash e o comando de recuperação com `git stash apply --index <hash>`; a inspeção e o quadro são relidos.

A prévia é vinculada ao checkout, HEAD, estado do índice e conteúdo rastreado/não rastreado. Mudanças entre prévia e confirmação exigem uma nova prévia, inclusive se o `git status` textual continua igual. Uma confirmação explícita é exigida pela API. Limpezas do mesmo repositório são serializadas no processo do harness, incluindo worktrees vinculadas. Não se promete bloquear edições de processos externos: o Git faz a operação de stash e a resposta verifica novamente a limpeza; se ainda houver alterações, a UI informa o backup e o estado pendente.

Runs em execução/pausadas impedem a limpeza. Conflitos, submódulos alterados e repositórios aninhados não rastreados exigem resolução específica e recebem diagnóstico, sem iniciar o stash. A ação é independente da integração de setup da #03 e não muda seu status.

A [ADR-0003](../../docs/adr/0003-limpeza-da-worktree-pelo-operador.md) e a Issue #12 registram a autorização do produto e os limites desta ação. O supervisor reserva o repositório contra operações de Run antes do primeiro await, incluindo preparação sem filho vivo, e usa o common-dir canônico para aliases/worktrees vinculadas.

## Verificação

- `tests/worktree-cleanup.test.ts`: testes sobre HTTP e Git reais em repositórios temporários. Cobrem prévia/cancelamento sem escrita, confirmação obrigatória, preservação e recuperação de alterações staged/unstaged/new, nomes com espaço/quebra de linha/caracteres de shell, arquivos ignorados, recusa de prévias antigas e tokens de outro projeto, isolamento entre checkout principal/worktree vinculada, renomeações/exclusões, submódulos, repositórios aninhados e Run pausada.
- Resultados da suíte e demais checks: [validação consolidada](pr-17-review-validation.md).
- `bun run typecheck` e `bun run build`: passaram.
- `bun scripts/browser-board.mjs`: o check existente exercita o fluxo de preview → cancelar → preview → confirmar no desktop e no celular contra a API real. Somente repositórios temporários do cenário são limpos; nenhuma worktree do operador é modificada. Verifica o backup, HEAD inalterado, worktree limpa e desaparecimento do botão/diagnóstico de árvore suja.

## Capturas

- [Prévia e confirmação no celular](screenshots/worktree-cleanup/cleanup-preview-390.png).
- [Resultado e instrução para recuperar o backup](screenshots/worktree-cleanup/cleanup-result-1280.png).


Para regenerar os mesmos nomes de evidência:

```sh
BROWSER_EVIDENCE_DIR=.scratch/prd-alignment/screenshots/worktree-cleanup bun scripts/browser-board.mjs
```

O runner emite os nomes usados pelos links diretamente; a saída padrão continua temporária.
