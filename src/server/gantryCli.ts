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

export type PackSubcommand = 'board' | 'issues' | 'specs' | 'frontier' | 'execute' | 'approve' | 'resume' | 'discard';

export interface PackRunRecord {
  ref: string;
  branch: string;
  phase: string;
  spent: number;
  granted: number;
  specPath?: string;
  issuePath?: string;
}

export function buildPackCommand(
  resolved: Exclude<PackExecutable, MissingPack>,
  repoRoot: string,
  subcommand: PackSubcommand,
  ...args: string[]
): string[] {
  const root = path.resolve(repoRoot);
  if (resolved.kind === 'pinned' || resolved.kind === 'global') {
    return [resolved.command[0], resolved.cliPath, '--cwd', root, subcommand, ...args];
  }
  return [resolved.executable, subcommand, ...args];
}

export function normaliseIssueRef(raw: string): string {
  const cleaned = raw.trim().replace(/^`+|`+$/g, '');
  const match = /^([a-z0-9][a-z0-9-]*)#(\d+)$/i.exec(cleaned);
  if (match) {
    return `${match[1].toLowerCase()}#${String(Number(match[2])).padStart(2, '0')}`;
  }
  return cleaned;
}

export function resolveGitCommonDir(repoRoot: string): string {
  const root = path.resolve(repoRoot);
  const dotGit = path.join(root, '.git');
  try {
    if (fs.existsSync(dotGit)) {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return dotGit;
      if (stat.isFile()) {
        const text = fs.readFileSync(dotGit, 'utf-8').trim();
        const match = /^gitdir:\s*(.+)$/i.exec(text);
        if (match) {
          const gitDir = path.resolve(root, match[1].trim());
          const commonDirFile = path.join(gitDir, 'commondir');
          if (fs.existsSync(commonDirFile)) {
            return path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf-8').trim());
          }
          return gitDir;
        }
      }
    }
  } catch {
    // Fallback below
  }
  return dotGit;
}

export function packRunRecordPath(repoRoot: string, ref: string): string {
  const canonicalRef = normaliseIssueRef(ref);
  return path.join(resolveGitCommonDir(repoRoot), 'gantry-cli', `${canonicalRef.replace(/#/g, '--')}.json`);
}

export function readPackRunRecord(repoRoot: string, ref: string): PackRunRecord | null {
  try {
    const filePath = packRunRecordPath(repoRoot, ref);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.ref !== 'string' || typeof raw.branch !== 'string' || typeof raw.phase !== 'string') {
      return null;
    }
    return {
      ref: raw.ref,
      branch: raw.branch,
      phase: raw.phase,
      spent: typeof raw.spent === 'number' ? raw.spent : 0,
      granted: typeof raw.granted === 'number' ? raw.granted : 0,
      ...(typeof raw.specPath === 'string' ? { specPath: raw.specPath } : {}),
      ...(typeof raw.issuePath === 'string' ? { issuePath: raw.issuePath } : {}),
    };
  } catch {
    return null;
  }
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
