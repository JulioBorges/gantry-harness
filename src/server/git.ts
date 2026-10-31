import { AsyncLocalStorage } from 'node:async_hooks';
import { findExecutable, runCommand } from './commandRunner.js';

const gitEnvironment = new AsyncLocalStorage<NodeJS.ProcessEnv>();

/** Runs Git commands inside `task` with this environment instead of `process.env`. */
export function withGitEnvironment<T>(env: NodeJS.ProcessEnv, task: () => Promise<T>): Promise<T> {
  return gitEnvironment.run(env, task);
}

function gitCommandOptions(root: string): { cwd: string; env?: NodeJS.ProcessEnv; inheritEnv?: boolean } {
  const stored = gitEnvironment.getStore();
  if (!stored) return { cwd: root };
  return { cwd: root, env: stored, inheritEnv: false };
}

/** PATH visto pelo `git` desta chamada. Fora de `withGitEnvironment`, o do processo. */
function gitSearchPath(): string | undefined {
  const stored = gitEnvironment.getStore();
  if (!stored) return undefined;
  return stored.PATH ?? '';
}

export const GIT_UNAVAILABLE_MESSAGE = 'Não foi possível executar o Git: o repositório não está acessível.';
export const GIT_NOT_FOUND_MESSAGE = 'Não foi possível executar o Git: o Git não está instalado ou não foi encontrado.';
export const GIT_FAILED_MESSAGE = 'Não foi possível executar o Git. Outro processo Git, um hook ou as permissões do repositório podem ter impedido a operação. Consulte o log do servidor.';
export const GIT_IDENTITY_MESSAGE = 'Defina user.name e user.email do repositório antes de continuar. O Git recusou a operação porque a identidade do autor ou do committer está ausente.';

export class GitError extends Error {
  constructor(message = GIT_UNAVAILABLE_MESSAGE, public readonly code = 'git-unavailable') {
    super(message);
  }
}

const UNAVAILABLE_SPAWN = new Set(['ENOENT', 'ENOTDIR', 'EACCES']);

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

function logGitFailure(root: string, args: string[], detail: { code?: string; exitCode?: number; stderr?: string; stdout?: string }): void {
  const output = (detail.stderr ?? '').trim() || (detail.stdout ?? '').trim();
  const status = detail.code ?? (detail.exitCode === undefined ? 'failed' : `exit ${detail.exitCode}`);
  console.error([`git failed (${status}): git ${args.join(' ')} (cwd ${root})`, output].filter(Boolean).join('\n'));
}

function gitFailure(exitCode: number, stderr: string, stdout: string): GitError {
  const text = `${stderr}\n${stdout}`;
  if (/author identity unknown|committer identity unknown|empty ident name/i.test(text)) return new GitError(GIT_IDENTITY_MESSAGE, 'git-identity-unknown');
  if (exitCode === 128 && /not a git repository/i.test(text)) return new GitError(GIT_UNAVAILABLE_MESSAGE, 'git-unavailable');
  return new GitError(GIT_FAILED_MESSAGE, 'git-failed');
}

function throwSpawnFailure(root: string, args: string[], error: unknown): never {
  const code = errorCode(error);
  if (code === 'ENOENT' && findExecutable('git', gitSearchPath()) === null) {
    logGitFailure(root, args, { code });
    throw new GitError(GIT_NOT_FOUND_MESSAGE, 'git-not-found');
  }
  if (UNAVAILABLE_SPAWN.has(code ?? '')) {
    logGitFailure(root, args, { code });
    throw new GitError();
  }
  throw error;
}

export async function git(root: string, ...args: string[]): Promise<string> {
  let result;
  try {
    result = await runCommand(['git', ...args], gitCommandOptions(root));
  } catch (error) {
    throwSpawnFailure(root, args, error);
  }
  if (result.exitCode !== 0) {
    logGitFailure(root, args, { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout });
    throw gitFailure(result.exitCode, result.stderr, result.stdout);
  }
  return result.stdout;
}

/** `git rev-parse -q --verify` exits 1 when the ref is absent. That is not a repository failure. */
export async function gitOptionalRef(root: string, ref: string): Promise<string> {
  const args = ['rev-parse', '-q', '--verify', ref];
  let result;
  try {
    result = await runCommand(['git', ...args], gitCommandOptions(root));
  } catch (error) {
    throwSpawnFailure(root, args, error);
  }
  if (result.exitCode === 0) return result.stdout.trim();
  if (result.exitCode === 1 && !result.stderr.trim()) return '';
  logGitFailure(root, args, { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout });
  throw gitFailure(result.exitCode, result.stderr, result.stdout);
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
