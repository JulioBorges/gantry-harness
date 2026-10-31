import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHarnessServer, type HarnessServerInstance } from '../src/server/app.js';
import { GIT_COMMITTER_IDENTITY_MESSAGE, GIT_FAILED_MESSAGE, GIT_IDENTITY_MESSAGE, GIT_NOT_FOUND_MESSAGE, GIT_UNAVAILABLE_MESSAGE, GitError, git, withGitEnvironment } from '../src/server/git.js';
import { gitIdentityEnv, withIsolatedGitEnv } from './gitTestEnv.js';

describe('Git failure messages', () => {
  const roots: string[] = [];
  let restoreEnv = () => {};
  beforeEach(() => {
    restoreEnv = withIsolatedGitEnv();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv();
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

  function captureLog(): string[] {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    return logged;
  }

  it('keeps the Git environment hermetic', () => {
    expect(process.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(process.env.HOME).toContain('gantry-git-home-');
  });

  it('keeps a missing repository on the unavailable message and logs the raw stderr', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-git-missing-'));
    roots.push(dir);
    const logged = captureLog();
    const error = await git(dir, 'status').then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).code).toBe('git-unavailable');
    expect((error as Error).message).toBe(GIT_UNAVAILABLE_MESSAGE);
    expect((error as Error).message).not.toContain(dir);
    expect(logged.join('\n')).toContain(dir);
    expect(logged.join('\n')).toMatch(/not a git repository/);
  });

  it('keeps a missing directory and ENOTDIR on the unavailable message when git is installed', async () => {
    const missing = path.join(os.tmpdir(), `gantry-missing-cwd-${Date.now()}`);
    const missingError = await git(missing, 'status').then(() => null, (caught: unknown) => caught);
    expect(missingError).toBeInstanceOf(GitError);
    expect((missingError as GitError).code).toBe('git-unavailable');
    expect((missingError as Error).message).toBe(GIT_UNAVAILABLE_MESSAGE);
    expect((missingError as Error).message).not.toContain(missing);

    const file = path.join(os.tmpdir(), `gantry-not-dir-${Date.now()}`);
    roots.push(file);
    fs.writeFileSync(file, 'not a directory\n');
    const notDir = await git(file, 'status').then(() => null, (caught: unknown) => caught);
    expect((notDir as GitError).code).toBe('git-unavailable');
    expect((notDir as Error).message).toBe(GIT_UNAVAILABLE_MESSAGE);
    expect((notDir as Error).message).not.toContain(file);
  });

  it('maps a missing author identity to a fixed message and its own code', async () => {
    const root = repo();
    fs.writeFileSync(path.join(process.env.HOME ?? '', '.gitconfig'), '[user]\n\tname = Global Operator\n\temail = global@example.test\n');
    execFileSync('git', ['config', '--unset', 'user.name'], { cwd: root });
    execFileSync('git', ['config', '--unset', 'user.email'], { cwd: root });
    fs.writeFileSync(path.join(root, 'README.md'), 'Hello\n');
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    const logged = captureLog();
    const error = await withGitEnvironment(gitIdentityEnv({
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
    }), () => git(root, 'commit', '-m', 'Needs an author')).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).code).toBe('git-identity-unknown');
    expect((error as Error).message).toBe(GIT_IDENTITY_MESSAGE);
    expect((error as Error).message).not.toMatch(/inacessível|Author identity unknown|Global Operator/);
    expect((error as Error).message).not.toContain(root);
    expect(logged.join('\n')).toMatch(/Author identity unknown/);
  });

  it('maps a missing committer identity to the same code without copying stderr', async () => {
    const root = repo();
    execFileSync('git', ['config', '--unset', 'user.name'], { cwd: root });
    execFileSync('git', ['config', '--unset', 'user.email'], { cwd: root });
    fs.writeFileSync(path.join(root, 'README.md'), 'Hello\n');
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    const logged = captureLog();
    const error = await withGitEnvironment(gitIdentityEnv({
      GIT_AUTHOR_NAME: 'Author Only',
      GIT_AUTHOR_EMAIL: 'author@example.test',
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
    }), () => git(root, 'commit', '-m', 'Needs a committer')).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).code).toBe('git-identity-unknown');
    expect((error as Error).message).toBe(GIT_COMMITTER_IDENTITY_MESSAGE);
    expect((error as Error).message).toMatch(/identidade do committer/);
    expect((error as Error).message).not.toMatch(/identidade do autor/);
    expect((error as Error).message).not.toMatch(/Committer identity unknown|auto-detect|ubuntu@/);
    expect((error as Error).message).not.toContain(root);
    expect(logged.join('\n')).toMatch(/Committer identity unknown/);
  });

  it('classifies ENOENT with the PATH stored by withGitEnvironment', async () => {
    const root = repo();
    const savedPath = process.env.PATH ?? '';
    const missing = path.join(os.tmpdir(), `gantry-als-path-${Date.now()}`);
    try {
      process.env.PATH = '';
      const missingDirectory = await withGitEnvironment({ ...process.env, PATH: savedPath }, () => git(missing, 'status')).then(() => null, (caught: unknown) => caught);
      expect(missingDirectory).toBeInstanceOf(GitError);
      expect((missingDirectory as GitError).code).toBe('git-unavailable');

      process.env.PATH = savedPath;
      const missingBinary = await withGitEnvironment({ ...process.env, PATH: '' }, () => git(root, 'status')).then(() => null, (caught: unknown) => caught);
      expect(missingBinary).toBeInstanceOf(GitError);
      expect((missingBinary as GitError).code).toBe('git-not-found');
      expect((missingBinary as Error).message).toBe(GIT_NOT_FOUND_MESSAGE);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('hints at the cause of an ordinary Git failure and keeps stderr in the server log', async () => {
    const root = repo();
    const logged = captureLog();
    const error = await git(root, 'checkout', 'does-not-exist').then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).code).toBe('git-failed');
    expect((error as Error).message).toBe(GIT_FAILED_MESSAGE);
    expect((error as Error).message).toMatch(/hook/);
    expect((error as Error).message).toMatch(/permissões/);
    expect((error as Error).message).toMatch(/log do servidor/);
    expect((error as Error).message).not.toMatch(/inacessível|pathspec|does-not-exist/);
    expect((error as Error).message).not.toContain(root);
    expect(logged.join('\n')).toMatch(/pathspec/);
    expect(logged.join('\n')).toContain(root);
  });

  it('reports a missing Git binary without a path in the response', async () => {
    const root = repo();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-git-missing-home-'));
    roots.push(home);
    const server: HarnessServerInstance = await createHarnessServer({
      port: 0,
      gantryHome: path.join(home, 'gantry'),
      homeDir: home,
      stateRoot: path.join(home, 'state'),
      profileRoot: path.join(home, 'profiles'),
    });
    const savedPath = process.env.PATH;
    try {
      const registered = await fetch(`http://127.0.0.1:${server.port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: root }),
      });
      expect(registered.ok).toBe(true);
      const id = (await registered.json()).project.id as string;
      process.env.PATH = '';
      const logged = captureLog();
      const response = await fetch(`http://127.0.0.1:${server.port}/api/projects/${id}/worktree/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await response.json();
      const encoded = JSON.stringify(body);
      expect(response.status).toBe(503);
      expect(body.code).toBe('git-not-found');
      expect(body.error).toBe(GIT_NOT_FOUND_MESSAGE);
      expect(encoded).not.toContain(root);
      expect(encoded).not.toContain(home);
      expect(encoded).not.toMatch(/ENOENT|spawn|\/tmp|\/usr/);
      expect(logged.join('\n')).toMatch(/ENOENT/);
      expect(logged.join('\n')).toContain(root);
    } finally {
      process.env.PATH = savedPath;
      await server.close();
    }
  });

  it('returns git-not-found for inspect and project registration when Git is not on PATH', async () => {
    const existing = repo();
    const created = repo();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-git-missing-home-'));
    roots.push(home);
    const server: HarnessServerInstance = await createHarnessServer({
      port: 0,
      gantryHome: path.join(home, 'gantry'),
      homeDir: home,
      stateRoot: path.join(home, 'state'),
      profileRoot: path.join(home, 'profiles'),
    });
    const savedPath = process.env.PATH;
    try {
      const registered = await fetch(`http://127.0.0.1:${server.port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: existing }),
      });
      expect(registered.ok).toBe(true);
      const id = (await registered.json()).project.id as string;
      process.env.PATH = '';
      const inspect = await fetch(`http://127.0.0.1:${server.port}/api/projects/${id}/inspect`);
      const inspectBody = await inspect.json();
      const inspectEncoded = JSON.stringify(inspectBody);
      expect(inspect.status).toBe(503);
      expect(inspectBody.code).toBe('git-not-found');
      expect(inspectBody.error).toBe(GIT_NOT_FOUND_MESSAGE);
      expect(inspectEncoded).not.toMatch(/ENOENT|spawn/);
      expect(inspectEncoded).not.toContain(existing);

      const response = await fetch(`http://127.0.0.1:${server.port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: created }),
      });
      const body = await response.json();
      const encoded = JSON.stringify(body);
      expect(response.status).toBe(503);
      expect(body.code).toBe('git-not-found');
      expect(body.error).toBe(GIT_NOT_FOUND_MESSAGE);
      expect(encoded).not.toMatch(/ENOENT|spawn/);
      expect(encoded).not.toContain(created);
    } finally {
      process.env.PATH = savedPath;
      await server.close();
    }
  });

  it('uses the fixed unavailable phrase when the project directory is gone', async () => {
    const root = repo();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-git-missing-home-'));
    roots.push(home);
    const server: HarnessServerInstance = await createHarnessServer({
      port: 0,
      gantryHome: path.join(home, 'gantry'),
      homeDir: home,
      stateRoot: path.join(home, 'state'),
      profileRoot: path.join(home, 'profiles'),
    });
    try {
      const registered = await fetch(`http://127.0.0.1:${server.port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: root }),
      });
      expect(registered.ok).toBe(true);
      const id = (await registered.json()).project.id as string;
      fs.rmSync(root, { recursive: true, force: true });
      const response = await fetch(`http://127.0.0.1:${server.port}/api/projects/${id}/inspect`);
      const body = await response.json();
      const encoded = JSON.stringify(body);
      expect(response.status).toBe(503);
      expect(body.code).toBe('git-unavailable');
      expect(body.error).toBe(GIT_UNAVAILABLE_MESSAGE);
      expect(encoded).not.toContain(root);
      expect(encoded).not.toMatch(/ENOENT|spawn/);
    } finally {
      await server.close();
    }
  });
});
