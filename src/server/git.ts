import { runCommand } from './commandRunner.js';

export class GitError extends Error {}

const UNAVAILABLE_SPAWN = new Set(['ENOTDIR', 'EACCES']);

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

/** Git's own text often repeats absolute paths; those must not reach the operator. */
function redactFilesystemPaths(text: string, root?: string): string {
  let redacted = text;
  if (root) redacted = redacted.replaceAll(root, '');
  return redacted
    .replace(/(?:[A-Za-z]:[\\/]|\/|~\/)[^\s"'`<>|;]+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([:.,])/g, '$1')
    .trim();
}

export async function git(root: string, ...args: string[]): Promise<string> {
  let result;
  try {
    result = await runCommand(['git', ...args], { cwd: root });
  } catch (error) {
    if (UNAVAILABLE_SPAWN.has(errorCode(error) ?? '')) {
      throw new GitError('Não foi possível executar o Git: o repositório não está acessível.');
    }
    throw error;
  }
  if (result.exitCode !== 0) {
    const detail = redactFilesystemPaths(result.stderr.trim() || result.stdout.trim(), root);
    throw new GitError(`Não foi possível executar o Git: ${detail || 'verifique o repositório.'}`);
  }
  return result.stdout;
}

export interface WorktreeFile {
  path: string;
  status: string;
  originalPath?: string;
}

export async function readWorktreeStatus(root: string): Promise<{ raw: string; files: WorktreeFile[] }> {
  const raw = await git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none');
  const records = raw.split('\0').filter(Boolean);
  const files: WorktreeFile[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const entry: WorktreeFile = { status: record.slice(0, 2), path: record.slice(3) };
    if (/[RC]/.test(entry.status)) entry.originalPath = records[++i];
    files.push(entry);
  }
  return { raw, files };
}
