import { runCommand } from './commandRunner.js';

export const GIT_UNAVAILABLE_MESSAGE = 'Não foi possível executar o Git: o repositório não está acessível.';

export class GitError extends Error {
  readonly code = 'git-unavailable';
  constructor(message = GIT_UNAVAILABLE_MESSAGE) {
    super(message);
  }
}

const UNAVAILABLE_SPAWN = new Set(['ENOTDIR', 'EACCES']);

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

function logGitFailure(root: string, args: string[], detail: { code?: string; exitCode?: number; stderr?: string; stdout?: string }): void {
  const output = (detail.stderr ?? '').trim() || (detail.stdout ?? '').trim();
  const status = detail.code ?? (detail.exitCode === undefined ? 'failed' : `exit ${detail.exitCode}`);
  console.error([`git unavailable (${status}): git ${args.join(' ')} (cwd ${root})`, output].filter(Boolean).join('\n'));
}

export async function git(root: string, ...args: string[]): Promise<string> {
  let result;
  try {
    result = await runCommand(['git', ...args], { cwd: root });
  } catch (error) {
    const code = errorCode(error);
    if (UNAVAILABLE_SPAWN.has(code ?? '')) {
      logGitFailure(root, args, { code });
      throw new GitError();
    }
    throw error;
  }
  if (result.exitCode !== 0) {
    logGitFailure(root, args, { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout });
    throw new GitError();
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
