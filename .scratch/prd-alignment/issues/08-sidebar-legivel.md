# 08: Reorganizar a sidebar para identificar e trocar projetos

Type: issue
Status: ready-for-agent
Slice: `prd-alignment#08`
Spec: `.scratch/prd-alignment/spec.md`
Created: 2026-10-20
Revised: 2026-10-20

## Parent

`prd-alignment`

## What to build

O operador identifica, seleciona e troca o projeto ativo sem informações ou controles ocultos. A linha de identificação contém nome, caminho e acesso às configurações; a lista expansível de worktrees fica abaixo, sem disputar a mesma linha horizontal com esses elementos. O nome pode quebrar linha. O caminho pode usar reticências desde que o valor completo seja acessível também no celular.

A lista mostra só worktrees de Issues que têm Run, identificadas pelo ref. O checkout principal não aparece. Não há ação de assumir o terminal no lugar do agente. Abrir as configurações carrega o projeto escolhido conforme o contrato da #03, inclusive depois de trocar de projeto.

A experiência deve ser exercitada com Playwright na UI servida: desktop e gaveta estreita, seleção e troca entre projetos, worktrees recolhidas/expandidas, nomes/caminhos longos e lista que exige rolagem. Rever o layout a partir desses cenários e registrar evidências antes/depois.

## Acceptance criteria

- [ ] Identificação/configurações e worktrees ocupam linhas separadas; expandir a lista não comprime nem oculta nome, caminho ou controles.
- [ ] Nome segue legível, podendo quebrar linha; caminho truncado tem acesso ao valor completo em desktop e celular.
- [ ] Projeto ativo é identificável; seleção e troca entre múltiplos projetos funcionam com listas recolhidas e expandidas, incluindo nomes/caminhos longos.
- [ ] Muitos projetos/worktrees podem ser percorridos sem tornar os controles inacessíveis nem provocar transbordamento horizontal na sidebar.
- [ ] O checkout principal não entra na lista. Só worktrees de Issues com Run aparecem, identificadas pelo ref.
- [ ] Não há controle de assumir o terminal a partir dessa lista.
- [ ] Abrir configurações de qualquer projeto abre e carrega aquele projeto conforme #03, sem exibir dados do anterior.
- [ ] Os comportamentos de navegação e filtragem são provados no seam da suíte portátil; Playwright valida o layout e as interações na UI servida em desktop e celular, com evidências antes/depois.

## Blocked by

- `prd-alignment#02`
- `prd-alignment#03` (contrato de carregamento da configuração do projeto)

## Comments

### 2026-10-20 — Revisão com o dono do produto e reprodução visual

Julio confirmou ampliar a issue para melhorar o layout e validar com Playwright. Em reprodução sobre o build atualizado, expandir Worktrees reduziu a largura do nome do projeto a zero em viewport 1280×800 e 390×844. O código coloca identificação, engrenagem e details de worktrees como irmãos dentro de `.project-row`, que usa flex horizontal. Separar as linhas elimina a disputa estrutural; a validação precisa esperar a inspeção carregar antes de expandir, pois o estado inicial sem worktrees não reproduz o defeito.
