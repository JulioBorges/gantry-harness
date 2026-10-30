import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GIT_FAILED_MESSAGE, GIT_IDENTITY_MESSAGE, GIT_UNAVAILABLE_MESSAGE, GitError, git } from '../src/server/git.js';

describe('Git failure messages', () => {
  const roots: string[] = [];
  const identityEnv = ['HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
  let savedEnv: Partial<Record<(typeof identityEnv)[number], string | undefined>> = {};
  let gitHome = '';
  beforeEach(() => {
    savedEnv = Object.fromEntries(identityEnv.map(key => [key, process.env[key]]));
    gitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-git-home-'));
    process.env.HOME = gitHome;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of identityEnv) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    if (gitHome) fs.rmSync(gitHome, { recursive: true, force: true });
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function repo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-git-error-'));
    roots.push(root);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Git error test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'git-error@example.test'], { cwd: root });
    return root;
  }

  it('keeps a missing repository on the unavailable message and logs the raw stderr', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-git-missing-'));
    roots.push(dir);
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const error = await git(dir, 'status').then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).code).toBe('git-unavailable');
    expect((error as Error).message).toBe(GIT_UNAVAILABLE_MESSAGE);
    expect((error as Error).message).not.toContain(dir);
    expect(logged.join('\n')).toContain(dir);
    expect(logged.join('\n')).toMatch(/not a git repository/);
  });

  it('maps a missing author identity to a fixed message and its own code', async () => {
    const root = repo();
    execFileSync('git', ['config', '--unset', 'user.name'], { cwd: root });
    execFileSync('git', ['config', '--unset', 'user.email'], { cwd: root });
    fs.writeFileSync(path.join(root, 'README.md'), 'Hello\n');
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const error = await git(root, 'commit', '-m', 'Needs an author').then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).code).toBe('git-identity-unknown');
    expect((error as Error).message).toBe(GIT_IDENTITY_MESSAGE);
    expect((error as Error).message).not.toMatch(/inacessível/);
    expect((error as Error).message).not.toContain(root);
    expect(logged.join('\n')).toMatch(/Author identity unknown/);
  });

  it('does not describe an ordinary Git failure as an inaccessible repository', async () => {
    const root = repo();
    const error = await git(root, 'checkout', 'does-not-exist').then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).code).toBe('git-failed');
    expect((error as Error).message).toBe(GIT_FAILED_MESSAGE);
    expect((error as Error).message).not.toMatch(/inacessível/);
    expect((error as Error).message).not.toContain(root);
  });
});
