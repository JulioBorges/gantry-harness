import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { GitError, GIT_FAILED_MESSAGE, git, gitOptionalRef, readWorktreeStatus, type WorktreeFile } from './git.js';

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

function logCleanupFailure(event: string, error: unknown, projectId: string): void {
  const rawCode = error instanceof GitError
    ? error.code
    : error instanceof WorktreeCleanupError
      ? 'worktree-cleanup'
      : typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'unknown';
  const code = /^[A-Za-z0-9_-]{1,40}$/.test(rawCode) ? rawCode : 'unknown';
  const safeProjectId = /^[A-Za-z0-9_-]{1,64}$/.test(projectId) ? projectId : 'invalid';
  console.error(JSON.stringify({ event, code, projectId: safeProjectId }));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** Runs after the restore plan is accepted and immediately before exclusive creates. Tests use it to simulate a race. */
let beforeExclusiveWrite: ((root: string) => void) | undefined;
/** Runs after an exclusive open is registered and before its bytes are written. Tests use it to fail mid-write. */
let afterExclusiveOpen: ((destination: string) => void) | undefined;

export function setWorktreeRestoreBeforeWrite(hook: ((root: string) => void) | undefined): void {
  beforeExclusiveWrite = hook;
}

export function setWorktreeRestoreAfterOpen(hook: ((destination: string) => void) | undefined): void {
  afterExclusiveOpen = hook;
}

function recoveryCommand(source: string, paths: string[]): string {
  return `git restore --source ${quoteShell(source)} --worktree -- ${paths.map(quoteShell).join(' ')}`;
}

interface RestoreEntry {
  path: string;
  mode: string;
  oid: string;
}

type ParentWalk = 'ok' | 'absent' | 'conflict';

function rootReal(root: string): string {
  return fs.realpathSync(root);
}

/** lstat each parent. A symlink or a non-directory is a conflict. An absent parent is not an escape. */
function walkParents(root: string, relative: string): ParentWalk {
  const realRoot = rootReal(root);
  const parts = relative.split('/');
  let current = realRoot;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const next = path.join(current, parts[index]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(next);
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? 'absent' : 'conflict';
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 'conflict';
    let real: string;
    try {
      real = fs.realpathSync(next);
    } catch {
      return 'conflict';
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return 'conflict';
    current = next;
  }
  return 'ok';
}

function conflictError(backup: string, conflicts: string[]): WorktreeCleanupError {
  return new WorktreeCleanupError(
    `Não recuperei o backup. Estes arquivos já existem e são diferentes do conteúdo guardado, ou o diretório pai não é seguro: ${conflicts.join(', ')}. Nenhum arquivo foi alterado.`,
    409,
    false,
    backup,
    conflicts,
  );
}

const RESTORE_WRITE_FAILED = 'Não recuperei o backup. A escrita falhou e os arquivos criados nesta chamada foram desfeitos.';

function restoreWriteFailed(backup: string, error: unknown, projectId: string): WorktreeCleanupError {
  logCleanupFailure('worktree-cleanup.restore-failed', error, projectId);
  return new WorktreeCleanupError(RESTORE_WRITE_FAILED, 409, false, backup);
}

async function diskState(root: string, relative: string, projectId: string): Promise<{ kind: 'missing' | 'occupied'; hash?: string; link?: string }> {
  const parents = walkParents(root, relative);
  if (parents === 'conflict') return { kind: 'occupied' };
  if (parents === 'absent') return { kind: 'missing' };
  const filename = path.join(rootReal(root), relative);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filename);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' };
    logCleanupFailure('worktree-cleanup.stat-failed', error, projectId);
    return { kind: 'occupied' };
  }
  if (stat.isSymbolicLink()) return { kind: 'occupied', link: fs.readlinkSync(filename) };
  if (!stat.isFile()) return { kind: 'occupied' };
  try {
    return { kind: 'occupied', hash: (await git(root, 'hash-object', '--', relative)).trim() };
  } catch (error) {
    logCleanupFailure('worktree-cleanup.hash-object-failed', error, projectId);
    return { kind: 'occupied' };
  }
}

interface UntrackedRestorePlan {
  missing: RestoreEntry[];
  conflicts: string[];
}

async function untrackedRestorePlan(root: string, backup: string, projectId: string): Promise<UntrackedRestorePlan> {
  // `^3` is the untracked commit. A tracked path restored from it deletes the worktree file and exits 0.
  const records = (await git(root, 'ls-tree', '-r', '-z', `${backup}^3`)).split('\0').filter(Boolean);
  const tracked = new Set((await git(root, 'ls-files', '-z')).split('\0').filter(Boolean));
  const missing: RestoreEntry[] = [];
  const conflicts: string[] = [];
  for (const record of records) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, , oid] = record.slice(0, tab).split(' ');
    const relative = safeRelativePath(record.slice(tab + 1));
    if (!relative || !oid || tracked.has(relative)) continue;
    if (mode !== '100644' && mode !== '100755' && mode !== '120000') {
      conflicts.push(relative);
      continue;
    }
    const state = await diskState(root, relative, projectId);
    if (state.kind === 'missing') {
      missing.push({ path: relative, mode, oid });
      continue;
    }
    if (mode === '120000' && state.link !== undefined) {
      const blob = await readGitBlob(root, oid);
      if (state.link === blob.toString('utf8')) continue;
    } else if (state.hash === oid) continue;
    conflicts.push(relative);
  }
  missing.sort((left, right) => left.path.localeCompare(right.path));
  conflicts.sort();
  return { missing, conflicts };
}

function readGitBlob(root: string, oid: string): Promise<Buffer> {
  if (!/^[0-9a-f]{40,64}$/.test(oid)) return Promise.reject(new WorktreeCleanupError('O blob informado não é um hash.', 400));
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', 'blob', oid], { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') reject(new GitError());
      else reject(error);
    });
    child.once('close', (status) => {
      if (status === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      const text = Buffer.concat(stderr).toString('utf8');
      if (status === 128 && /not a git repository/i.test(text)) reject(new GitError());
      else reject(new GitError(GIT_FAILED_MESSAGE, 'git-failed'));
    });
  });
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

async function recoveryAfterPartialStash(root: string, backup: string, after: WorktreeFile[], before: WorktreeFile[], projectId: string): Promise<Pick<WorktreeCleanupResult, 'keep' | 'restore' | 'reverted' | 'restoreTracked' | 'conflicts'>> {
  const keep = after
    .filter(file => file.status !== '??')
    .map(file => safeRelativePath(file.path))
    .filter((entry): entry is string => Boolean(entry))
    .sort();
  let plan: UntrackedRestorePlan = { missing: [], conflicts: [] };
  let reverted: string[] = [];
  try {
    plan = await untrackedRestorePlan(root, backup, projectId);
  } catch (error) {
    logCleanupFailure('worktree-cleanup.untracked-list-failed', error, projectId);
  }
  try {
    reverted = await revertedTracked(root, backup, before);
  } catch (error) {
    logCleanupFailure('worktree-cleanup.tracked-list-failed', error, projectId);
  }
  return {
    ...(keep.length > 0 ? { keep } : {}),
    ...(plan.missing.length > 0 ? { restore: recoveryCommand(`${backup}^3`, plan.missing.map(entry => entry.path)) } : {}),
    ...(plan.conflicts.length > 0 ? { conflicts: plan.conflicts } : {}),
    ...(reverted.length > 0 ? { reverted, restoreTracked: recoveryCommand(backup, reverted) } : {}),
  };
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

export async function cleanWorktree(checkout: string, token: unknown, projectId: string): Promise<WorktreeCleanupResult> {
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
        return { backup, clean: false, verified: false, ...await recoveryAfterPartialStash(preview.root, backup, status.files, preview.files, projectId) };
      } catch (error) {
        logCleanupFailure('worktree-cleanup.partial-unverified', error, projectId);
        return { backup, clean: false, verified: false };
      }
    }
    try {
      const status = await readWorktreeStatus(preview.root);
      return { backup, clean: status.files.length === 0, verified: true };
    } catch (error) {
      logCleanupFailure('worktree-cleanup.verify-failed', error, projectId);
      return { backup, clean: false, verified: false };
    }
  } finally {
    cleaning.delete(commonDir);
  }
}

function ensureParents(root: string, relative: string, createdDirs: string[]): string {
  const realRoot = rootReal(root);
  const parts = relative.split('/');
  let current = realRoot;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const next = path.join(current, parts[index]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(next);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw conflictError('', [relative]);
      try {
        fs.mkdirSync(next);
        createdDirs.push(next);
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
      }
      stat = fs.lstatSync(next);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw conflictError('', [relative]);
    const real = fs.realpathSync(next);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw conflictError('', [relative]);
    current = next;
  }
  return path.join(current, parts[parts.length - 1]);
}

async function createMissingEntries(root: string, backup: string, entries: RestoreEntry[], projectId: string): Promise<string[]> {
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];
  const rollback = () => {
    for (const file of [...createdFiles].reverse()) {
      try { fs.unlinkSync(file); } catch { /* the exclusive create is the only thing we remove */ }
    }
    for (const dir of [...createdDirs].reverse()) {
      try { fs.rmdirSync(dir); } catch { /* leave a directory we did not empty */ }
    }
  };
  try {
    beforeExclusiveWrite?.(root);
    for (const entry of entries) {
      if (walkParents(root, entry.path) === 'conflict') throw conflictError(backup, [entry.path]);
      let destination: string;
      try {
        destination = ensureParents(root, entry.path, createdDirs);
      } catch (error) {
        if (error instanceof WorktreeCleanupError) throw conflictError(backup, [entry.path]);
        if (errorCode(error) === 'EEXIST') throw conflictError(backup, [entry.path]);
        throw restoreWriteFailed(backup, error, projectId);
      }
      const data = await readGitBlob(root, entry.oid);
      try {
        if (entry.mode === '120000') {
          fs.symlinkSync(data.toString('utf8'), destination);
          createdFiles.push(destination);
        } else {
          const mode = entry.mode === '100755' ? 0o755 : 0o644;
          const fd = fs.openSync(destination, 'wx', mode);
          createdFiles.push(destination);
          try {
            afterExclusiveOpen?.(destination);
            fs.writeSync(fd, data);
          } finally {
            fs.closeSync(fd);
          }
          fs.chmodSync(destination, mode);
        }
      } catch (error) {
        if (errorCode(error) === 'EEXIST') throw conflictError(backup, [entry.path]);
        throw restoreWriteFailed(backup, error, projectId);
      }
    }
  } catch (error) {
    rollback();
    throw error;
  }
  return entries.map(entry => entry.path);
}

export async function applyWorktreeRestore(checkout: string, backup: unknown, confirmed: unknown, projectId: string): Promise<WorktreeRestoreResult> {
  if (typeof backup !== 'string' || !STASH_HASH.test(backup)) {
    throw new WorktreeCleanupError('O backup informado não é um hash de stash.', 400);
  }
  const root = resolveCheckout(checkout);
  return withCleaningLock(root, async () => {
    const known = await listCleanupBackups(root);
    if (!known.some(item => item.hash === backup)) {
      throw new WorktreeCleanupError('O backup informado não é uma limpeza deste repositório.', 409, false, backup);
    }
    const plan = await untrackedRestorePlan(root, backup, projectId);
    if (plan.conflicts.length > 0) throw conflictError(backup, plan.conflicts);
    if (plan.missing.length === 0) return { backup, restored: [] };
    if (confirmed !== true) throw new WorktreeCleanupError('Confirme a recuperação após revisar os arquivos.', 400, false, backup);
    const again = await untrackedRestorePlan(root, backup, projectId);
    const samePaths = again.missing.map(entry => entry.path).join('\0') === plan.missing.map(entry => entry.path).join('\0');
    if (again.conflicts.length > 0 || !samePaths) {
      throw new WorktreeCleanupError('Os arquivos mudaram antes da recuperação. Nada foi escrito.', 409, false, backup, again.conflicts);
    }
    const restored = await createMissingEntries(root, backup, again.missing, projectId);
    return { backup, restored };
  });
}
