import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GitError, git, gitOptionalRef, readWorktreeStatus, type WorktreeFile } from './git.js';

export interface WorktreeCleanupBackup {
  hash: string;
  subject: string;
}

export interface WorktreeCleanupPreview {
  root: string;
  token: string;
  files: WorktreeFile[];
  backups: WorktreeCleanupBackup[];
}

export class WorktreeCleanupError extends Error {
  constructor(
    message: string,
    public statusCode = 409,
    public worktreeMutated = false,
    public backup?: string,
    public conflicts?: string[],
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
  hash.update(await gitOptionalRef(root, 'refs/stash'));
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
  return { root, token: hash.digest('hex'), files, backups: await listCleanupBackups(root) };
}

async function listCleanupBackups(root: string): Promise<WorktreeCleanupBackup[]> {
  const text = await git(root, 'stash', 'list', '--format=%H%x00%gs');
  const backups: WorktreeCleanupBackup[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('gantry-harness-cleanup-')) continue;
    const [hash, subject = ''] = line.split('\0');
    if (hash && STASH_HASH.test(hash)) backups.push({ hash, subject });
  }
  return backups;
}

// ADR-0003: the supervisor coordinates Runs; this writer lock also protects direct callers.
const cleaning = new Set<string>();

export interface WorktreeCleanupResult {
  backup: string;
  clean: boolean;
  verified: boolean;
  /** Tracked paths still in the worktree. Deleting them leaves the blob only in the index. */
  keep?: string[];
  /** Restores untracked paths from `<backup>^3` that are no longer on disk. Never includes a tracked path. */
  restore?: string;
  /** Tracked paths whose worktree bytes no longer match the stash commit after a partial reset. */
  reverted?: string[];
  /** `git restore --source <backup> --worktree -- <reverted>`. Does not touch the index. */
  restoreTracked?: string;
  /** Untracked paths that exist and differ from `<backup>^3`. They are omitted from `restore`. */
  conflicts?: string[];
}

export interface WorktreeRestoreResult {
  backup: string;
  restored: string[];
}

function safeRelativePath(filePath: string): string | undefined {
  if (!filePath || filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)) return undefined;
  if (filePath.includes('\0') || filePath.includes('\n')) return undefined;
  if (filePath.split(/[\\/]/).includes('..')) return undefined;
  return filePath;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function logCleanupFailure(event: string, error: unknown): void {
  const rawCode = error instanceof GitError
    ? error.code
    : error instanceof WorktreeCleanupError
      ? 'worktree-cleanup'
      : typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'unknown';
  const code = /^[A-Za-z0-9_-]{1,40}$/.test(rawCode) ? rawCode : 'unknown';
  console.error(JSON.stringify({ event, code }));
}

function recoveryCommand(source: string, paths: string[]): string {
  return `git restore --source ${quoteShell(source)} --worktree -- ${paths.map(quoteShell).join(' ')}`;
}

interface DiskState {
  kind: 'missing' | 'occupied';
  hash?: string;
}

async function diskState(root: string, relative: string): Promise<DiskState> {
  const filename = path.join(root, relative);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filename);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return { kind: 'missing' };
    logCleanupFailure('worktree-cleanup.stat-failed', error);
    return { kind: 'occupied' };
  }
  if (!stat.isFile()) return { kind: 'occupied' };
  try {
    return { kind: 'occupied', hash: (await git(root, 'hash-object', '--', relative)).trim() };
  } catch (error) {
    logCleanupFailure('worktree-cleanup.hash-object-failed', error);
    return { kind: 'occupied' };
  }
}

interface UntrackedRestorePlan {
  missing: string[];
  conflicts: string[];
}

async function untrackedRestorePlan(root: string, backup: string): Promise<UntrackedRestorePlan> {
  // `^3` is the untracked commit. A tracked path restored from it deletes the worktree file and exits 0.
  const records = (await git(root, 'ls-tree', '-r', '-z', `${backup}^3`)).split('\0').filter(Boolean);
  const tracked = new Set((await git(root, 'ls-files', '-z')).split('\0').filter(Boolean));
  const missing: string[] = [];
  const conflicts: string[] = [];
  for (const record of records) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const hash = record.slice(0, tab).split(' ')[2];
    const relative = safeRelativePath(record.slice(tab + 1));
    if (!relative || !hash || tracked.has(relative)) continue;
    const state = await diskState(root, relative);
    if (state.kind === 'missing') missing.push(relative);
    else if (state.hash !== hash) conflicts.push(relative);
  }
  missing.sort();
  conflicts.sort();
  return { missing, conflicts };
}

async function revertedTracked(root: string, backup: string, before: WorktreeFile[]): Promise<string[]> {
  const trackedBefore = [...new Set(before
    .filter(file => file.status !== '??')
    .map(file => safeRelativePath(file.path))
    .filter((entry): entry is string => Boolean(entry)))].sort();
  if (trackedBefore.length === 0) return [];
  const diff = await git(root, 'diff', '--no-renames', '--name-only', '-z', backup, '--', ...trackedBefore);
  const allowed = new Set(trackedBefore);
  return [...new Set(diff.split('\0')
    .map(safeRelativePath)
    .filter((entry): entry is string => entry !== undefined && allowed.has(entry)))].sort();
}

async function recoveryAfterPartialStash(root: string, backup: string, after: WorktreeFile[], before: WorktreeFile[]): Promise<Pick<WorktreeCleanupResult, 'keep' | 'restore' | 'reverted' | 'restoreTracked' | 'conflicts'>> {
  const keep = after
    .filter(file => file.status !== '??')
    .map(file => safeRelativePath(file.path))
    .filter((entry): entry is string => Boolean(entry))
    .sort();
  try {
    const plan = await untrackedRestorePlan(root, backup);
    const reverted = await revertedTracked(root, backup, before);
    return {
      ...(keep.length > 0 ? { keep } : {}),
      ...(plan.missing.length > 0 ? { restore: recoveryCommand(`${backup}^3`, plan.missing) } : {}),
      ...(plan.conflicts.length > 0 ? { conflicts: plan.conflicts } : {}),
      ...(reverted.length > 0 ? { reverted, restoreTracked: recoveryCommand(backup, reverted) } : {}),
    };
  } catch (error) {
    logCleanupFailure('worktree-cleanup.recovery-list-failed', error);
    return keep.length > 0 ? { keep } : {};
  }
}

async function withCleaningLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const commonDir = resolveCheckout(path.resolve(root, (await git(root, 'rev-parse', '--git-common-dir')).trim()));
  if (cleaning.has(commonDir)) throw new WorktreeCleanupError('Já existe uma limpeza em andamento neste repositório.');
  cleaning.add(commonDir);
  try {
    return await action();
  } finally {
    cleaning.delete(commonDir);
  }
}

export async function cleanWorktree(checkout: string, token: unknown): Promise<WorktreeCleanupResult> {
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
    if (pushError) {
      try {
        const status = await readWorktreeStatus(preview.root);
        return { backup, clean: false, verified: false, ...await recoveryAfterPartialStash(preview.root, backup, status.files, preview.files) };
      } catch (error) {
        logCleanupFailure('worktree-cleanup.partial-unverified', error);
        return { backup, clean: false, verified: false };
      }
    }
    try {
      const status = await readWorktreeStatus(preview.root);
      return { backup, clean: status.files.length === 0, verified: true };
    } catch (error) {
      logCleanupFailure('worktree-cleanup.verify-failed', error);
      return { backup, clean: false, verified: false };
    }
  } finally {
    cleaning.delete(commonDir);
  }
}

export async function applyWorktreeRestore(checkout: string, backup: unknown, confirmed: unknown): Promise<WorktreeRestoreResult> {
  if (typeof backup !== 'string' || !STASH_HASH.test(backup)) {
    throw new WorktreeCleanupError('O backup informado não é um hash de stash.');
  }
  const root = resolveCheckout(checkout);
  return withCleaningLock(root, async () => {
    const known = await listCleanupBackups(root);
    if (!known.some(item => item.hash === backup)) {
      throw new WorktreeCleanupError('O backup informado não é uma limpeza deste repositório.', 409, false, backup);
    }
    const plan = await untrackedRestorePlan(root, backup);
    if (plan.conflicts.length > 0) {
      throw new WorktreeCleanupError(
        `Não recuperei o backup. Estes arquivos já existem e são diferentes do conteúdo guardado: ${plan.conflicts.join(', ')}. Nenhum arquivo foi alterado.`,
        409,
        false,
        backup,
        plan.conflicts,
      );
    }
    if (plan.missing.length === 0) return { backup, restored: [] };
    if (confirmed !== true) throw new WorktreeCleanupError('Confirme a recuperação após revisar os arquivos.', 400, false, backup);
    const again = await untrackedRestorePlan(root, backup);
    if (again.conflicts.length > 0 || again.missing.join('\0') !== plan.missing.join('\0')) {
      throw new WorktreeCleanupError('Os arquivos mudaram antes da recuperação. Nada foi escrito.', 409, false, backup, again.conflicts);
    }
    try {
      await git(root, 'restore', '--source', `${backup}^3`, '--worktree', '--', ...again.missing);
    } catch (error) {
      logCleanupFailure('worktree-cleanup.restore-failed', error);
      if (error instanceof GitError && error.code !== 'git-unavailable') {
        throw new WorktreeCleanupError('O Git não concluiu a recuperação. O backup continua no stash. Revise a worktree antes de tentar de novo.', 409, true, backup);
      }
      throw error;
    }
    return { backup, restored: again.missing };
  });
}
