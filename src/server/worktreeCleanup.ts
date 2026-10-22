import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runCommand } from './commandRunner.js';

export interface WorktreeCleanupPreview {
  root: string;
  token: string;
  files: Array<{ path: string; status: string; originalPath?: string }>;
}

export class WorktreeCleanupError extends Error {
  constructor(message: string, public statusCode = 409) { super(message); }
}

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await runCommand(['git', ...args], { cwd: root });
  if (result.exitCode !== 0) throw new WorktreeCleanupError(`Não foi possível preparar a limpeza: ${result.stderr.trim() || 'verifique o estado do Git.'}`);
  return result.stdout;
}

export async function previewWorktreeCleanup(checkout: string): Promise<WorktreeCleanupPreview> {
  const root = fs.realpathSync(checkout);
  const gitRoot = fs.realpathSync((await git(root, 'rev-parse', '--show-toplevel')).trim());
  if (root !== gitRoot) throw new WorktreeCleanupError('Abra a raiz da worktree para limpar o projeto.');
  const head = (await git(root, 'rev-parse', '--verify', 'HEAD')).trim();
  const status = await git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none');
  const records = status.split('\0').filter(Boolean);
  const files: WorktreeCleanupPreview['files'] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const entry: WorktreeCleanupPreview['files'][number] = { status: record.slice(0, 2), path: record.slice(3) };
    if (/[RC]/.test(entry.status)) entry.originalPath = records[++i];
    if (/U/.test(entry.status) || entry.status === 'AA' || entry.status === 'DD') {
      throw new WorktreeCleanupError('Resolva os conflitos do Git antes de limpar a worktree.');
    }
    files.push(entry);
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

const cleaning = new Set<string>();

export async function cleanWorktree(checkout: string, token: unknown): Promise<{ backup: string; clean: boolean }> {
  const commonDir = fs.realpathSync(path.resolve(checkout, (await git(checkout, 'rev-parse', '--git-common-dir')).trim()));
  if (cleaning.has(commonDir)) throw new WorktreeCleanupError('Já existe uma limpeza em andamento neste repositório.');
  cleaning.add(commonDir);
  try {
    const preview = await previewWorktreeCleanup(checkout);
    if (typeof token !== 'string' || preview.token !== token) throw new WorktreeCleanupError('Os arquivos mudaram desde a prévia. Revise a limpeza novamente.');
    if (!preview.files.length) throw new WorktreeCleanupError('A worktree já está limpa.');
    const marker = `gantry-harness-cleanup-${crypto.randomUUID()}`;
    await git(preview.root, 'stash', 'push', '--include-untracked', '--message', marker);
    // Match our own reflog entry rather than assuming another process has not pushed a stash.
    const entries = (await git(preview.root, 'reflog', 'show', '--format=%H%x00%gs', 'refs/stash')).split('\n');
    const backup = entries.find(entry => entry.includes(marker))?.split('\0')[0];
    if (!backup || !/^[0-9a-f]{40,64}$/.test(backup)) throw new WorktreeCleanupError('O Git criou o stash, mas não foi possível identificar o backup. Consulte git stash list antes de continuar.');
    const status = await git(preview.root, 'status', '--porcelain=v1', '--untracked-files=all');
    return { backup, clean: status.trim() === '' };
  } finally {
    cleaning.delete(commonDir);
  }
}
