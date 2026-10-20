# 09: Não abrir o terminal sozinho

Type: issue
Status: ready-for-agent
Slice: `prd-alignment#09`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20

## Parent

`prd-alignment`

## What to build

O operador vai para Terminal e encontra a vista, não um shell novo. Shell só nasce pelo controle de nova aba. Fechar a aba encerra aquele processo. Um processo ainda rodando não aparece como concluído. O aviso de que o pack não está instalado fica no Quadro e não se repete em Terminal nem em Arquivos.

## Acceptance criteria

- [ ] Ir para Terminal, pelo seletor ou pela sidebar, não cria processo de shell.
- [ ] O controle de nova aba cria um shell no diretório do projeto, e fechar essa aba encerra o processo.
- [ ] Enquanto o processo roda, a aba não usa o estado visual de concluído. Depois de encerrar, usa.
- [ ] Num projeto sem pack, o aviso aparece no Quadro e não aparece em Terminal nem em Arquivos.
- [ ] Preferências de terminal continuam valendo para a aba nova.
- [ ] Os casos são provados no seam do workspace renderizado.

## Blocked by

- `prd-alignment#01`
