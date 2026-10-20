# 11: Documentar o setup integrado após o pin compatível

Type: issue
Status: ready-for-agent
Slice: `prd-alignment#11`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20

## Parent

`prd-alignment`

## What to build

Depois que #03 entregar o setup integrado e um pin compatível com U1/U2/U3, atualizar README, descrição de produto e ajuda para descrever a configuração efetivamente disponível: política completa do projeto, modelos por papel, detecção do checkout, prévia/aplicação pelo script, perfis pessoais separados e ausência de commit automático. Os textos gerais e traduções independentes são entregues na #10 sem esperar o upstream.

No mesmo trabalho, substituir no PRD a ressalva sobre o pin antigo pela referência ao pin compatível e à evidência de integração. Preservar o histórico na ADR-0001 e no relatório de investigação; não apagar o motivo da decisão. Não anunciar o setup alvo como disponível antes da aceitação da #03.

## Acceptance criteria

- [ ] README, descrição de produto e ajuda descrevem os campos e efeitos reais do setup entregue pela #03, sem execução direta de modelos pelo harness.
- [ ] Os textos distinguem defaults do projeto de valores efetivos/perfis pessoais e explicam prévia/aplicação sem commit automático.
- [ ] PRD e spec apontam para o pin compatível e a evidência de U1/U2/U3; a ressalva operacional sobre o pin antigo é retirada da descrição vigente sem apagar o histórico da ADR/relatório.
- [ ] Títulos, rótulos e orientações correspondem à UI entregue; as verificações existentes pertinentes passam.

## Blocked by

- `prd-alignment#03`
- `prd-alignment#10`

## Comments

### 2026-10-20 — Separação dos textos dependentes do upstream

Extraída da #10 após a segunda revisão arquitetural do PR #15. A #10 fica livre para alinhar e traduzir o produto atual; esta issue concentra os textos que precisam do setup integrado e a retirada das ressalvas vencidas no bump do pin.
