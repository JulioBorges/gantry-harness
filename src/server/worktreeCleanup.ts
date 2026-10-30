import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GitError, git, readWorktreeStatus, type WorktreeFile } from './git.js';

export interface WorktreeCleanupPreview {
  root: string;
  token: string;
  files: WorktreeFile[];
}

export class WorktreeCleanupError extends Error {
  constructor(
    message: string,
    public statusCode = 409,
    public worktreeMutated = false,
    public backup?: string,
  ) { super(message); }
}

const STASH_HASH = /^[0-9a-f]{40,64}$/;

function resolveCheckout(checkout: string): string {
  try {
    return fs.realpathSync(checkout);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') throw new GitError('Não foi possível executar o Git: o diretório do projeto não está mais disponível.');
    if (code === 'ENOTDIR' || code === 'EACCES') throw new GitError('Não foi possível executar o Git: o repositório não está acessível.');
    throw error;
  }
}

function hashFromReflog(reflog: string, marker: string): string | undefined {
  const hash = reflog.split('\n').find(entry => entry.includes(marker))?.split('\0')[0];
  return hash && STASH_HASH.test(hash) ? hash : undefined;
}

async function stashMarkerHash(root: string, args: string[], marker: string): Promise<string | undefined> {
  try {
    return hashFromReflog(await git(root, ...args), marker);
  } catch {
    return undefined;
  }
}

async function identifyStashBackup(root: string, marker: string): Promise<string | undefined> {
  // Git commands only. refs/stash may live in reftable, where logs/refs/stash is absent.
  return await stashMarkerHash(root, ['reflog', 'show', '--format=%H%x00%gs', 'refs/stash'], marker)
    ?? await stashMarkerHash(root, ['stash', 'list', '--format=%H%x00%gs'], marker);
}

export async function previewWorktreeCleanup(checkout: string): Promise<WorktreeCleanupPreview> {
  const root = resolveCheckout(checkout);
  const gitRoot = resolveCheckout((await git(root, 'rev-parse', '--show-toplevel')).trim());
  if (root !== gitRoot) throw new WorktreeCleanupError('Abra a raiz da worktree para limpar o projeto.');
  const head = (await git(root, 'rev-parse', '--verify', 'HEAD')).trim();
  const { raw: status, files } = await readWorktreeStatus(root);
  if (files.some(file => /U/.test(file.status) || file.status === 'AA' || file.status === 'DD')) {
    throw new WorktreeCleanupError('Resolva os conflitos do Git antes de limpar a worktree.');
  }
  const submodules = (await git(root, 'ls-files', '--stage', '-z')).split('\0')
    .filter(record => record.startsWith('160000 ')).map(record => record.slice(record.indexOf('\t') + 1));
  if (files.some(file => submodules.includes(file.path))) {
    throw new WorktreeCleanupError('Há alterações em submódulos. Resolva-as no próprio submódulo antes de limpar.');
  }
  const hash = crypto.createHash('sha256').update(JSON.stringify([root, head, status]));
  hash.update(await git(root, 'diff', '--binary', '--no-ext-diff', '--no-textconv'));
  hash.update(await git(root, 'diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'));
  for (const file of files.filter(file => file.status === '??')) {
    const filename = path.join(root, file.path);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new WorktreeCleanupError('Há um repositório ou diretório não rastreado que não pode ser guardado no stash. Resolva-o antes de limpar.');
    hash.update(JSON.stringify([file.path, stat.mode]));
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(filename));
    else for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  }
  return { root, token: hash.digest('hex'), files };
}

// ADR-0003: the supervisor coordinates Runs; this writer lock also protects direct callers.
const cleaning = new Set<string>();

export async function cleanWorktree(checkout: string, token: unknown): Promise<{ backup: string; clean: boolean; verified: boolean }> {
  const root = resolveCheckout(checkout);
  const commonDir = resolveCheckout(path.resolve(root, (await git(root, 'rev-parse', '--git-common-dir')).trim()));
  if (cleaning.has(commonDir)) throw new WorktreeCleanupError('Já existe uma limpeza em andamento neste repositório.');
  cleaning.add(commonDir);
  try {
    const preview = await previewWorktreeCleanup(checkout);
    if (typeof token !== 'string' || preview.token !== token) throw new WorktreeCleanupError('Os arquivos mudaram desde a prévia. Revise a limpeza novamente.');
    if (!preview.files.length) throw new WorktreeCleanupError('A worktree já está limpa.');
    const marker = `gantry-harness-cleanup-${crypto.randomUUID()}`;
    let pushError: unknown;
    try {
      await git(preview.root, 'stash', 'push', '--include-untracked', '--message', marker);
    } catch (error) {
      // stash push can write the stash and still exit 1, for example when an untracked path cannot be removed.
      pushError = error;
    }
    // Leave the stash in place. Rolling it back can fail halfway and is harder to recover than a known hash.
    const backup = await identifyStashBackup(preview.root, marker);
    if (!backup) {
      if (pushError) throw pushError;
      throw new WorktreeCleanupError('O Git criou o stash, mas não foi possível identificar o backup. Consulte git stash list antes de continuar.', 409, true);
    }
    if (pushError) return { backup, clean: false, verified: false };
    try {
      const status = await readWorktreeStatus(preview.root);
      return { backup, clean: status.files.length === 0, verified: true };
    } catch {
      return { backup, clean: false, verified: false };
    }
  } finally {
    cleaning.delete(commonDir);
  }
}
