import fs from 'node:fs';
import os from 'node:os';
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

export interface GlobalPack {
  kind: 'global';
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

export type PackExecutable = PinnedPack | GlobalPack | PathPack | MissingPack;

export function pinnedCliPath(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), '.agents', 'skills', 'gantry', 'scripts', 'cli.py');
}

export function globalCliPath(homeDir: string): string {
  return path.join(path.resolve(homeDir), '.agents', 'skills', 'gantry', 'scripts', 'cli.py');
}

function pythonCommand(kind: 'pinned' | 'global', cliPath: string, root: string): PackExecutable {
  const python = findExecutable('python3') ?? (process.platform === 'win32' ? findExecutable('python') : null);
  if (!python) {
    return {
      kind: 'none',
      explanation: 'O cli.py do Gantry precisa de python3 no PATH para ler o quadro.',
    };
  }
  return { kind, cliPath, command: [python, cliPath, '--cwd', root, 'board'] };
}

export function resolvePackExecutable(repoRoot: string, homeDir: string = os.homedir()): PackExecutable {
  const root = path.resolve(repoRoot);
  const pinned = pinnedCliPath(root);
  if (fs.existsSync(pinned) && fs.statSync(pinned).isFile()) {
    return pythonCommand('pinned', pinned, root);
  }
  const globalCli = globalCliPath(homeDir);
  if (fs.existsSync(globalCli) && fs.statSync(globalCli).isFile()) {
    return pythonCommand('global', globalCli, root);
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

export async function readBoard(repoRoot: string, homeDir: string = os.homedir()): Promise<BoardSnapshot> {
  const resolved = resolvePackExecutable(repoRoot, homeDir);
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
