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

function parsePackRunRecordObject(raw: unknown): PackRunRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.ref !== 'string' || typeof obj.branch !== 'string' || typeof obj.phase !== 'string') {
    return null;
  }
  return {
    ref: normaliseIssueRef(obj.ref),
    branch: obj.branch,
    phase: obj.phase,
    spent: typeof obj.spent === 'number' ? obj.spent : 0,
    granted: typeof obj.granted === 'number' ? obj.granted : 0,
    ...(typeof obj.specPath === 'string' ? { specPath: obj.specPath } : {}),
    ...(typeof obj.issuePath === 'string' ? { issuePath: obj.issuePath } : {}),
  };
}

export function listPackRunRecords(repoRoot: string): PackRunRecord[] {
  try {
    const dir = path.join(resolveGitCommonDir(repoRoot), 'gantry-cli');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    const entries = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
    const records: PackRunRecord[] = [];
    for (const entry of entries) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf-8'));
        const parsed = parsePackRunRecordObject(raw);
        if (parsed) records.push(parsed);
      } catch {
        // ignore invalid record
      }
    }
    return records;
  } catch {
    return [];
  }
}

export function readPackRunRecord(repoRoot: string, refOrSlug: string): PackRunRecord | null {
  try {
    const trimmed = refOrSlug.trim();
    if (trimmed.includes('#')) {
      const filePath = packRunRecordPath(repoRoot, trimmed);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return parsePackRunRecordObject(raw);
    }
    const prefix = `${trimmed.toLowerCase()}#`;
    const matches = listPackRunRecords(repoRoot).filter(
      (record) => record.ref.toLowerCase().startsWith(prefix),
    );
    return matches.at(-1) ?? null;
  } catch {
    return null;
  }
}

export function deletePackRunRecord(repoRoot: string, ref: string): void {
  try {
    const filePath = packRunRecordPath(repoRoot, ref);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore
  }
}

export interface RepoArtifactAndGitPolicy {
  artifacts: {
    specs: string;
    issues: string;
  };
  git: {
    target: string;
    prefix: string;
    issueBranch: string;
  };
}

export function resolveRepoPolicy(repoRoot: string): RepoArtifactAndGitPolicy {
  const defaults: RepoArtifactAndGitPolicy = {
    artifacts: {
      specs: '.scratch/{slug}/spec.md',
      issues: '.scratch/{slug}/issues',
    },
    git: {
      target: 'main',
      prefix: 'gantry/',
      issueBranch: '{prefix}{spec}-{number:02d}',
    },
  };
  try {
    const cfgPath = path.join(path.resolve(repoRoot), '.gantry', 'config.json');
    if (!fs.existsSync(cfgPath) || !fs.statSync(cfgPath).isFile()) return defaults;
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
    const rawArtifacts =
      raw.artifacts && typeof raw.artifacts === 'object' ? (raw.artifacts as Record<string, unknown>) : {};
    const rawGit = raw.git && typeof raw.git === 'object' ? (raw.git as Record<string, unknown>) : {};
    return {
      artifacts: {
        specs: typeof rawArtifacts.specs === 'string' ? rawArtifacts.specs : defaults.artifacts.specs,
        issues: typeof rawArtifacts.issues === 'string' ? rawArtifacts.issues : defaults.artifacts.issues,
      },
      git: {
        target: typeof rawGit.target === 'string' ? rawGit.target : defaults.git.target,
        prefix: typeof rawGit.prefix === 'string' ? rawGit.prefix : defaults.git.prefix,
        issueBranch:
          typeof rawGit.issueBranch === 'string' ? rawGit.issueBranch : defaults.git.issueBranch,
      },
    };
  } catch {
    return defaults;
  }
}

export function hasExistingSpecOrIssue(repoRoot: string, slug: string): boolean {
  const root = path.resolve(repoRoot);
  const policy = resolveRepoPolicy(root);
  const specRel = policy.artifacts.specs.replace(/\{slug\}/g, slug);
  const specPath = path.join(root, specRel);
  if (fs.existsSync(specPath) && fs.statSync(specPath).isFile()) {
    return true;
  }
  const issuesRel = policy.artifacts.issues.replace(/\{slug\}/g, slug);
  const issuesDir = path.join(root, issuesRel);
  if (fs.existsSync(issuesDir) && fs.statSync(issuesDir).isDirectory()) {
    const mdFiles = fs.readdirSync(issuesDir).filter((name) => name.endsWith('.md'));
    if (mdFiles.length > 0) {
      return true;
    }
  }
  return false;
}

export function renderExpectedIssueBranch(repoRoot: string, ref: string): string | null {
  const canonical = normaliseIssueRef(ref);
  const parts = canonical.split('#');
  if (parts.length !== 2) return null;
  const spec = parts[0];
  const number = Number(parts[1]);
  if (!spec || !Number.isInteger(number) || number <= 0) return null;
  const policy = resolveRepoPolicy(repoRoot);
  return policy.git.issueBranch
    .replace(/\{prefix\}/g, policy.git.prefix)
    .replace(/\{spec\}/g, spec)
    .replace(/\{number:02d\}/g, String(number).padStart(2, '0'))
    .replace(/\{number\}/g, String(number));
}

export function expectedWorktreePath(repoRoot: string, branch: string): string {
  return path.join(path.resolve(repoRoot), '.gantry', 'worktrees', branch.replace(/\//g, '-'));
}

export function readIssueTitleFromWorktree(worktreePath: string, issueRelPath: string): string | null {
  try {
    const filePath = path.join(path.resolve(worktreePath), issueRelPath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    const text = fs.readFileSync(filePath, 'utf-8');
    const match = /^#\s+(.+?)\s*$/m.exec(text);
    return match ? match[1].trim() : null;
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
  const result = await runCommand(resolved.command, { cwd: path.resolve(repoRoot), env: { PYTHONDONTWRITEBYTECODE: '1' } });
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
