import { runCommand } from './commandRunner.js';

export class GitError extends Error {}

export async function git(root: string, ...args: string[]): Promise<string> {
  const result = await runCommand(['git', ...args], { cwd: root });
  if (result.exitCode !== 0) throw new GitError(`Não foi possível executar o Git: ${result.stderr.trim() || result.stdout.trim() || 'verifique o repositório.'}`);
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
