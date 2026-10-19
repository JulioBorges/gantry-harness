import fs from 'node:fs';
import path from 'node:path';
import { findExecutable, runCommand } from './commandRunner.js';
import {
  NO_PACK_EXPLANATION,
  emptyBoard,
  parsePackBoard,
  type BoardSnapshot,
  type PackResolutionKind,
} from '../boardModel.js';

export interface PinnedPack {
  kind: 'pinned';
  command: string[];
  cliPath: string;
}

export interface PathPack {
  kind: 'path';
  command: string[];
  executable: string;
}

export interface MissingPack {
  kind: 'none';
  explanation: string;
}

export type PackExecutable = PinnedPack | PathPack | MissingPack;

export function pinnedCliPath(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), '.agents', 'skills', 'gantry', 'scripts', 'cli.py');
}

export function resolvePackExecutable(repoRoot: string): PackExecutable {
  const root = path.resolve(repoRoot);
  const cliPath = pinnedCliPath(root);
  if (fs.existsSync(cliPath) && fs.statSync(cliPath).isFile()) {
    const python = findExecutable('python3') ?? (process.platform === 'win32' ? findExecutable('python') : null);
    if (!python) {
      return {
        kind: 'none',
        explanation: 'O cli.py deste repositório precisa de python3 no PATH para ler o quadro.',
      };
    }
    return {
      kind: 'pinned',
      cliPath,
      command: [python, cliPath, '--cwd', root, 'board'],
    };
  }
  const gantry = findExecutable('gantry');
  if (gantry) {
    return { kind: 'path', executable: gantry, command: [gantry, 'board'] };
  }
  return { kind: 'none', explanation: NO_PACK_EXPLANATION };
}

function failedRead(resolution: PackResolutionKind, explanation: string): BoardSnapshot {
  return emptyBoard(resolution, explanation);
}

export async function readBoard(repoRoot: string): Promise<BoardSnapshot> {
  const resolved = resolvePackExecutable(repoRoot);
  if (resolved.kind === 'none') return emptyBoard('none', resolved.explanation);
  const result = await runCommand(resolved.command, { cwd: path.resolve(repoRoot) });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    return failedRead(resolved.kind, `O comando board do pack falhou: ${detail}`);
  }
  try {
    const parsed = parsePackBoard(JSON.parse(result.stdout));
    return {
      resolution: resolved.kind,
      executionEnabled: true,
      explanation: null,
      ...parsed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unreadable board';
    return failedRead(resolved.kind, `A saída de board não é um quadro válido: ${message}`);
  }
}
