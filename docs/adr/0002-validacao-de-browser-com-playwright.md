# Validação de browser com Playwright no check browser-validation

Status: accepted (2026-10-20).

Migrar o CDP direto de `scripts/browser-board.mjs` para Playwright, mantendo o comando `bun scripts/browser-board.mjs`, o nome `browser-validation` e seu registro em `.gantry/config.json`. A decisão atende à validação de experiência solicitada pelo dono do produto para a sidebar e torna seleção, expansão e medidas de layout mais simples de exercitar; os cenários existentes do quadro permanecem no mesmo check.

A alternativa era estender o CDP atual e usar Playwright apenas na investigação, evitando dependência nova. Preferimos Playwright como implementação do único runner de browser, sem manter duas validações permanentes para os mesmos cenários. A #08 deve declarar a dependência de desenvolvimento, documentar instalação do navegador/requisitos do ambiente e validar quadro/sidebar em 1280×800 e 390×844. Esta ADR registra a decisão; a migração executável ainda será entregue na #08.
