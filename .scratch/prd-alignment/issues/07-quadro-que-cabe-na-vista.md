# 07: Fazer o quadro caber na vista

Type: issue
Status: ready-for-agent
Slice: `prd-alignment#07`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20

## Parent

`prd-alignment`

## What to build

O operador, num repositório com muitas Issues done e poucas em andamento, vê de imediato quantas estão prontas, bloqueadas, em execução, esperando a ele, prontas para aprovar e done. Ativar uma contagem leva à coluna correspondente. Coluna sem card não ocupa a largura de uma coluna com card.

Na largura em que a navegação já vira gaveta, o quadro vira uma lista com seletor de fase, sem sete colunas lado a lado. O número ao lado de Quadro é o de pausas em aberto.

## Acceptance criteria

- [ ] A faixa mostra as seis contagens e cada uma leva à coluna certa, inclusive Done quando ela não nasceria na área visível.
- [ ] Uma coluna sem card fica reduzida ao título; uma coluna com card continua legível.
- [ ] Abaixo da largura da gaveta, o quadro é uma lista filtrada por fase e a página não exige scroll horizontal das sete colunas.
- [ ] O contador na entrada Quadro é igual ao número de Runs com pausa em aberto, e zera quando nenhuma pausa está aberta.
- [ ] A ação de onda com confirmação, a pausa em português e o card pronto para aprovação continuam utilizáveis nessa faixa e nessa lista.
- [ ] Os casos são provados no seam da suíte portátil, incluindo a largura estreita.

## Blocked by

- `prd-alignment#05`
- `prd-alignment#06`
