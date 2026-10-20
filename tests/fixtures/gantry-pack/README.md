# Cópia pinada do pack Gantry

Estes scripts são o `cli.py` real do pack e os módulos que a suíte do pipeline executa. Não vêm de `~/.agents/skills/gantry` nem de um checkout pessoal.

| Campo | Valor |
| --- | --- |
| Repositório | https://github.com/JulioBorges/gantry |
| Commit | `dc5bdd3571253af628ab629f1edcd58fa81fe2b1` |
| Licença | Apache-2.0 (`LICENSE` nesta pasta) |

Arquivos, no mesmo caminho do pack (`.agents/skills/gantry/scripts/`):

- `cli.py` — quadro, execute, resume, discard e approve
- `common.py` — política e leitura de Issues que o `cli.py` importa
- `roadmap.py` — fechamento que o approve chama
- `acceptance.py` — módulo que o approve do pack espera ao lado do `cli.py`
- `runlog.py` — contrato de stdin que o harness ainda usa para o id da unidade e o append do registro

O pin também está em `SOURCE.json`. A suíte copia esta pasta para `.agents/skills/gantry/scripts/` de um repositório git temporário e faz commit dela antes de subir o harness.

## Como atualizar

1. Escolha o commit novo em https://github.com/JulioBorges/gantry.
2. Substitua cada arquivo em `scripts/` pelo blob do mesmo caminho nesse commit.
3. Atualize `commit` em `SOURCE.json` e a tabela deste README.
4. Rode `bun run test` com `HOME` limpo, sem `~/.agents/skills/gantry`.
