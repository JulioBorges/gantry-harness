#!/usr/bin/env python3
"""Valida o gantry-harness rodando a suíte automatizada."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    if not (ROOT / "node_modules").is_dir():
        print(f"Dependências ausentes em {ROOT}. Rode bun install.", file=sys.stderr, flush=True)
        return 1
    bun = shutil.which("bun")
    if bun is None:
        print("bun não está no PATH.", file=sys.stderr, flush=True)
        return 1

    print(f"Rodando os testes automatizados de {ROOT.name}", flush=True)
    completed = subprocess.run([bun, "run", "test"], cwd=ROOT)
    if completed.returncode == 0:
        print(f"PASS {ROOT.name}", flush=True)
        return 0
    print(f"FAIL {ROOT.name}: bun run test saiu com {completed.returncode}", file=sys.stderr, flush=True)
    return completed.returncode or 1


if __name__ == "__main__":
    raise SystemExit(main())
