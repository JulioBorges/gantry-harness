import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { createHarnessServer, type HarnessServerInstance } from '../src/server/app.js';
import { nativeFetch } from './setup-app-origin.js';
import * as gitModule from '../src/server/git.js';

const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
if (runningAsRoot) {
  console.warn('Skipping EACCES worktree cleanup coverage: this suite is running as root, so directory mode does not deny access.');
}

function gitSpawnCode(cwd: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const child = spawn('git', ['status'], { cwd, stdio: 'ignore' });
    child.once('error', error => resolve(typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'error'));
    child.once('close', () => resolve(undefined));
  });
}

let root: string;
let repo: string;
let server: HarnessServerInstance;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
function initRepo(name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Cleanup test');
  git(dir, 'config', 'user.email', 'cleanup@example.test');
  // Ignore inherited commit signing and fsmonitor; both can stall git while tests create repos.
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.fsmonitor', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'Original\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.log\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Initial');
  return dir;
}
async function register(dir: string) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) });
  expect(response.ok).toBe(true);
  return (await response.json()).project.id as string;
}
function request(id: string, action: 'preview' | 'clean', body: object = {}) {
  return fetch(`http://127.0.0.1:${server.port}/api/projects/${id}/worktree/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${server.port}` },
    body: JSON.stringify(body),
  });
}
function rawRequest(id: string, action: 'preview' | 'clean', init: { origin?: string | null; contentType?: string | null; body?: string } = {}) {
  const headers = new Headers();
  if (init.contentType !== null) headers.set('Content-Type', init.contentType ?? 'application/json');
  if (init.origin !== null) headers.set('Origin', init.origin ?? `http://127.0.0.1:${server.port}`);
  return nativeFetch(`http://127.0.0.1:${server.port}/api/projects/${id}/worktree/${action}`, { method: 'POST', headers, body: init.body ?? '{}' });
}
function seedReady(projectId: string) {
  server.store.saveRun({ runId: `ready-${projectId}`, projectId, ref: 'watch#01', slug: 'watch', kind: 'issue', status: 'ready-for-approval', childPid: null, pid: null, childHandle: null, lane: 'critic', packPhase: 'ready', branch: null, worktree: null, pushed: false, pause: null, pausedReason: null, pausedChoices: null, terminalEvent: 'ready-for-approval', error: null, prUrl: null, derivedPhase: 'ready-for-approval', createdAt: '', updatedAt: '' });
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-cleanup-test-'));
  repo = initRepo('project');
  server = await createHarnessServer({ port: 0, gantryHome: path.join(root, 'home'), homeDir: root, stateRoot: path.join(root, 'state'), profileRoot: path.join(root, 'profiles') });
});
afterEach(async () => { vi.restoreAllMocks(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe('Worktree cleanup over HTTP', () => {
  it('previews without writes and backs up staged, unstaged and new files before cleaning', async () => {
    const id = await register(repo);
    const head = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'README.md'), 'Staged\n');
    git(repo, 'add', 'README.md');
    fs.writeFileSync(path.join(repo, 'README.md'), 'Unstaged\n');
    const unusual = 'new file\n$(never-run).txt';
    fs.writeFileSync(path.join(repo, unusual), 'New content\n');
    fs.writeFileSync(path.join(repo, 'ignored.log'), 'Keep ignored\n');
    const status = git(repo, 'status', '--porcelain');
    const staged = git(repo, 'diff', '--cached');
    const response = await request(id, 'preview');
    expect(response.status).toBe(200);
    const preview = await response.json();
    expect(preview.files.map((file: { path: string }) => file.path)).toEqual(['README.md', unusual]);
    expect(git(repo, 'status', '--porcelain')).toBe(status);
    expect(git(repo, 'stash', 'list')).toBe('');
    const cleaned = await request(id, 'clean', { confirmed: true, token: preview.token });
    expect(cleaned.status).toBe(200);
    const result = await cleaned.json();
    expect(result.clean).toBe(true);
    expect(result.backup).toMatch(/^[a-f0-9]{40,64}$/);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(fs.readFileSync(path.join(repo, 'ignored.log'), 'utf8')).toBe('Keep ignored\n');
    git(repo, 'stash', 'apply', '--index', result.backup);
    expect(git(repo, 'status', '--porcelain')).toBe(status);
    expect(git(repo, 'diff', '--cached')).toBe(staged);
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('Unstaged\n');
    expect(fs.readFileSync(path.join(repo, unusual), 'utf8')).toBe('New content\n');
  });

  it.each(['tracked', 'new', 'staged'])('refuses a stale preview after %s content changes with the same status', async kind => {
    const id = await register(repo);
    const file = kind === 'new' ? 'notes.txt' : 'README.md';
    fs.writeFileSync(path.join(repo, file), 'Before\n');
    if (kind === 'staged') git(repo, 'add', file);
    const preview = await (await request(id, 'preview')).json();
    fs.writeFileSync(path.join(repo, file), 'After!\n');
    if (kind === 'staged') git(repo, 'add', file);
    const response = await request(id, 'clean', { confirmed: true, token: preview.token });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('mudaram');
    expect(fs.readFileSync(path.join(repo, file), 'utf8')).toBe('After!\n');
    expect(git(repo, 'stash', 'list')).toBe('');
  });

  it('refuses a preview token after a new cleanup backup and lists only those backups', async () => {
    const id = await register(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'Dirty\n');
    const first = await (await request(id, 'preview')).json();
    expect(first.backups).toEqual([]);
    git(repo, 'stash', 'push', '--include-untracked', '--message', 'gantry-harness-cleanup-existing');
    git(repo, 'stash', 'apply', '--index');
    git(repo, 'stash', 'push', '--include-untracked', '--message', 'unrelated');
    git(repo, 'stash', 'apply', '--index');
    const second = await (await request(id, 'preview')).json();
    const cleanupHash = git(repo, 'rev-parse', 'stash@{1}');
    expect(second.token).not.toBe(first.token);
    expect(second.backups).toEqual([{ hash: cleanupHash, subject: expect.stringContaining('gantry-harness-cleanup-existing') }]);
    expect(JSON.stringify(second.backups)).not.toContain('unrelated');
    expect(JSON.stringify(second.backups)).not.toContain(repo);
    const refused = await request(id, 'clean', { confirmed: true, token: first.token });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/mudaram/i);
    expect(git(repo, 'stash', 'list').split('\n').filter(Boolean)).toHaveLength(2);
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('Dirty\n');
  });

  it('requires confirmation and binds the preview to the selected checkout', async () => {
    const id = await register(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'Keep\n');
    const preview = await (await request(id, 'preview')).json();
    expect((await request(id, 'clean', { token: preview.token })).status).toBe(400);
    const other = initRepo('other');
    fs.writeFileSync(path.join(other, 'README.md'), 'Other\n');
    const otherId = await register(other);
    expect((await request(otherId, 'clean', { token: preview.token, confirmed: true })).status).toBe(409);
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('Keep\n');
    expect(fs.readFileSync(path.join(other, 'README.md'), 'utf8')).toBe('Other\n');
  });

  it('cleans a linked worktree without touching the main checkout', async () => {
    const linked = path.join(root, 'linked');
    git(repo, 'worktree', 'add', '-b', 'feature', linked);
    fs.writeFileSync(path.join(repo, 'README.md'), 'Main work\n');
    fs.writeFileSync(path.join(linked, 'README.md'), 'Linked work\n');
    const id = await register(linked);
    const preview = await (await request(id, 'preview')).json();
    expect(preview.root).toBe(fs.realpathSync(linked));
    expect((await request(id, 'clean', { token: preview.token, confirmed: true })).status).toBe(200);
    expect(git(linked, 'status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('Main work\n');
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    expect(git(linked, 'branch', '--show-current')).toBe('feature');
  });

  it('refuses nested repositories without touching their files', async () => {
    const id = await register(repo);
    const nested = path.join(repo, 'nested');
    fs.mkdirSync(nested);
    git(nested, 'init');
    fs.writeFileSync(path.join(nested, 'keep.txt'), 'Nested work');
    expect((await request(id, 'preview')).status).toBe(409);
    expect(fs.readFileSync(path.join(nested, 'keep.txt'), 'utf8')).toBe('Nested work');
    expect(git(repo, 'stash', 'list')).toBe('');
  });

  it('reports renamed and deleted files accurately and preserves their backup', async () => {
    const id = await register(repo);
    git(repo, 'mv', 'README.md', 'renamed notes.md');
    fs.unlinkSync(path.join(repo, '.gitignore'));
    const preview = await (await request(id, 'preview')).json();
    expect(preview.files).toContainEqual({ path: 'renamed notes.md', originalPath: 'README.md', status: 'R ' });
    expect(preview.files).toContainEqual({ path: '.gitignore', status: ' D' });
    const response = await request(id, 'clean', { confirmed: true, token: preview.token });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.clean).toBe(true);
    git(repo, 'stash', 'apply', '--index', result.backup);
    expect(fs.existsSync(path.join(repo, 'README.md'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'renamed notes.md'), 'utf8')).toBe('Original\n');
    expect(fs.existsSync(path.join(repo, '.gitignore'))).toBe(false);
  });

  it('refuses dirty submodules before creating any backup or changing files', async () => {
    const source = initRepo('submodule-source');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'sub');
    git(repo, 'commit', '-am', 'Add submodule');
    const id = await register(repo);
    fs.writeFileSync(path.join(repo, 'sub/README.md'), 'Submodule work\n');
    const response = await request(id, 'preview');
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('submódulos');
    expect(fs.readFileSync(path.join(repo, 'sub/README.md'), 'utf8')).toBe('Submodule work\n');
    expect(git(repo, 'stash', 'list')).toBe('');
  });

  it('refuses cleanup while a Run is running or paused', async () => {
    const id = await register(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'Keep\n');
    const preview = await (await request(id, 'preview')).json();
    server.store.saveRun({ runId: 'run-active', projectId: id, ref: 'test#01', slug: 'test', kind: 'issue', status: 'paused', childPid: null, pid: null, childHandle: null, lane: 'implement', packPhase: 'implement', branch: null, worktree: repo, pushed: false, pause: null, pausedReason: null, pausedChoices: null, terminalEvent: null, error: null, prUrl: null, derivedPhase: 'paused', createdAt: '', updatedAt: '' });
    expect((await request(id, 'clean', { token: preview.token, confirmed: true })).status).toBe(409);
    expect(git(repo, 'stash', 'list')).toBe('');
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('Keep\n');
  });
  it('prevents lifecycle mutations through aliases and linked worktrees until cleanup releases its reservation', async () => {
    const id = await register(repo);
    const project = server.store.getProject(id)!;
    const linked = path.join(root, 'linked-lock');
    git(repo, 'worktree', 'add', '-b', 'lock-test', linked);
    const linkedProject = server.store.getProject(await register(linked))!;
    const alias = path.join(root, 'alias');
    fs.symlinkSync(repo, alias, 'dir');
    const aliasedProject = { ...project, id: 'alias-project', path: alias };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cleaning = server.runSupervisor.withProjectQuiesced(project, () => gate);
    try {
      for (const target of [project, linkedProject, aliasedProject]) {
        await expect(server.runSupervisor.startRun({ project: target, ref: 'test#01' })).rejects.toMatchObject({ code: 'cleanup-in-progress' });
        await expect(server.runSupervisor.executeWave({ project: target })).rejects.toMatchObject({ code: 'cleanup-in-progress' });
        await expect(server.runSupervisor.resumeRun({ project: target, ref: 'test#01' })).rejects.toMatchObject({ code: 'cleanup-in-progress' });
        await expect(server.runSupervisor.approveRun({ project: target, ref: 'test#01' })).rejects.toMatchObject({ code: 'cleanup-in-progress' });
        await expect(server.runSupervisor.reattachProject(target)).rejects.toMatchObject({ code: 'cleanup-in-progress' });
        await expect(server.runSupervisor.withProjectQuiesced(target, async () => undefined)).rejects.toMatchObject({ code: 'cleanup-in-progress' });
      }
    } finally { release(); await cleaning; }
    expect((await request(id, 'preview')).status).toBe(200);
    await expect(server.runSupervisor.withProjectQuiesced(project, async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    expect((await request(id, 'preview')).status).toBe(200);
  });

  it('reserves wave preparation before the first child exists and releases the reservation after failure', async () => {
    const id = await register(repo);
    const project = server.store.getProject(id)!;
    const scripts = path.join(repo, '.agents/skills/gantry/scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'cli.py'), `import pathlib, time
root = pathlib.Path.cwd()
(root / 'wave-entered').touch()
while not (root / 'wave-release').exists():
    time.sleep(0.01)
print('invalid board output')
`);
    const wave = server.runSupervisor.executeWave({ project }).catch(error => error);
    await vi.waitFor(() => expect(fs.existsSync(path.join(repo, 'wave-entered'))).toBe(true), { timeout: 5000 });
    try {
      await expect(server.runSupervisor.withProjectQuiesced(project, async () => undefined)).rejects.toMatchObject({ code: 'run-active' });
    } finally { fs.writeFileSync(path.join(repo, 'wave-release'), ''); }
    await wave;
    await expect(server.runSupervisor.withProjectQuiesced(project, async () => 'released')).resolves.toBe('released');
  });

  it('counts exactly the same changed files in inspection and cleanup preview', async () => {
    const id = await register(repo);
    fs.mkdirSync(path.join(repo, 'notes'));
    fs.writeFileSync(path.join(repo, 'notes/first.txt'), 'First');
    fs.writeFileSync(path.join(repo, 'notes/second.txt'), 'Second');
    const preview = await (await request(id, 'preview')).json();
    const inspection = await fetch(`http://127.0.0.1:${server.port}/api/projects/${id}/inspect`).then(response => response.json());
    expect(preview.files).toHaveLength(2);
    expect(inspection.diagnostics.dirtyFiles).toHaveLength(preview.files.length);
    expect(inspection.remediationCards.find((card: { kind: string }) => card.kind === 'dirty_worktree').description).toContain('2 alteração');
  });

  it('checks the live child even when a persisted status no longer says running', async () => {
    const id = await register(repo);
    const project = server.store.getProject(id)!;
    const scripts = path.join(repo, '.agents/skills/gantry/scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'cli.py'), `import json, pathlib, sys, time
root = pathlib.Path.cwd()
if 'board' in sys.argv:
    print(json.dumps({'issues': [], 'specs': [], 'frontier': []}))
else:
    print(json.dumps({'event': 'worktree', 'branch': 'test', 'worktree': str(root), 'pushed': False}), flush=True)
    while not (root / 'child-release').exists():
        time.sleep(0.01)
`);
    const started = await server.runSupervisor.startRun({ project, ref: 'test#01' });
    server.store.saveRun({ ...started, status: 'stopped' });
    try {
      await expect(server.runSupervisor.withProjectQuiesced(project, async () => undefined)).rejects.toMatchObject({ code: 'run-active' });
    } finally { fs.writeFileSync(path.join(repo, 'child-release'), ''); }
  });

  it('keeps board, workspace and project registration readable during cleanup', async () => {
    const id = await register(repo);
    const project = server.store.getProject(id)!;
    seedReady(id);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cleanup = server.runSupervisor.withProjectQuiesced(project, () => gate);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const boardResponse = await fetch(`${base}/api/projects/${id}/board`);
      expect(boardResponse.status).toBe(200);
      expect((await boardResponse.json()).runs.map((run: { ref: string }) => run.ref)).toContain('watch#01');
      const workspace = await fetch(`${base}/api/workspace/state`);
      expect(workspace.status).toBe(200);
      expect((await workspace.json()).projects.some((item: { id: string }) => item.id === id)).toBe(true);
      expect(await register(repo)).toBe(id);
    } finally { release(); await cleanup; }
  });

  it('waits for an in-flight refresh rather than refusing cleanup and returns stored state to later readers', async () => {
    const id = await register(repo);
    const project = server.store.getProject(id)!;
    const scripts = path.join(repo, '.agents/skills/gantry/scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'cli.py'), `import json, pathlib, time
root = pathlib.Path.cwd()
(root / 'refresh-entered').touch()
while not (root / 'refresh-release').exists():
    time.sleep(0.01)
print(json.dumps({'issues': [], 'specs': [], 'frontier': []}))
`);
    const refresh = server.runSupervisor.refreshProject(project);
    await vi.waitFor(() => expect(fs.existsSync(path.join(repo, 'refresh-entered'))).toBe(true), { timeout: 5000 });
    let cleaned = false;
    const cleanup = server.runSupervisor.withProjectQuiesced(project, async () => { cleaned = true; });
    try {
      await expect(server.runSupervisor.refreshProject(project)).resolves.toEqual([]);
      expect(cleaned).toBe(false);
    } finally { fs.writeFileSync(path.join(repo, 'refresh-release'), ''); }
    await refresh;
    await cleanup;
    expect(cleaned).toBe(true);
  });

  it('does not let a ready Run in another repository make the watcher reserve the clean project', async () => {
    const id = await register(repo);
    const other = initRepo('watched-project');
    const otherId = await register(other);
    const refresh = vi.spyOn(server.runSupervisor, 'refreshProject');
    seedReady(otherId);
    await vi.waitFor(() => expect(refresh.mock.calls.some(([project]) => project.id === otherId)).toBe(true), { timeout: 5000 });
    expect(refresh.mock.calls.some(([project]) => project.id === id)).toBe(false);
    expect((await request(id, 'preview')).status).toBe(200);
  });

  it('continues refreshing other watched projects after one refresh fails', async () => {
    const id = await register(repo);
    const otherId = await register(initRepo('watched-after-failure'));
    const original = server.runSupervisor.refreshProject.bind(server.runSupervisor);
    const refresh = vi.spyOn(server.runSupervisor, 'refreshProject').mockImplementation((project, board) => {
      if (project.id === id) return Promise.reject(new Error('Unavailable first project'));
      return original(project, board);
    });
    seedReady(id);
    seedReady(otherId);
    await vi.waitFor(() => expect(refresh.mock.calls.some(([project]) => project.id === otherId)).toBe(true), { timeout: 5000 });
    expect(refresh.mock.calls.some(([project]) => project.id === id)).toBe(true);
  });

  it('reports a bare repository inspection as a Git failure without calling it inaccessible', async () => {
    const id = await register(repo);
    git(repo, 'config', 'core.bare', 'true');
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/projects/${id}/inspect`);
      const body = await response.json();
      expect(response.status).toBe(409);
      expect(body.code).toBe('git-failed');
      expect(body.error).toBe(gitModule.GIT_FAILED_MESSAGE);
      expect(body.error).not.toMatch(/inacessível/);
      expect(JSON.stringify(body)).not.toContain(repo);
    } finally { git(repo, 'config', 'core.bare', 'false'); }
  });

  it.each(['preview', 'clean'] as const)('reports a deleted project directory as git-unavailable on %s', async (action) => {
    const id = await register(repo);
    const removed = repo;
    fs.rmSync(removed, { recursive: true, force: true });
    const response = await request(id, action, { confirmed: true, token: 'a'.repeat(64) });
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.code).toBe('git-unavailable');
    expect(JSON.stringify(body)).not.toMatch(/ENOENT|lstat|posix_spawn/);
    expect(JSON.stringify(body)).not.toContain(removed);
  });

  it.each(['preview', 'clean'] as const)('reports a removed linked worktree as git-unavailable on %s', async (action) => {
    const linked = path.join(root, 'linked');
    git(repo, 'worktree', 'add', '-b', 'feature', linked);
    const id = await register(linked);
    git(repo, 'worktree', 'remove', '--force', linked);
    const response = await request(id, action, { confirmed: true, token: 'a'.repeat(64) });
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.code).toBe('git-unavailable');
    expect(JSON.stringify(body)).not.toMatch(/ENOENT|lstat|posix_spawn/);
    expect(JSON.stringify(body)).not.toContain(linked);
  });

  it.each(['preview', 'clean'] as const)('reports an orphan linked worktree with the same unavailable message on %s', async (action) => {
    const linked = path.join(root, 'linked');
    git(repo, 'worktree', 'add', '-b', 'feature', linked);
    const id = await register(linked);
    const gitdir = path.resolve(linked, fs.readFileSync(path.join(linked, '.git'), 'utf8').trim().replace(/^gitdir:\s*/, ''));
    fs.rmSync(gitdir, { recursive: true, force: true });
    expect(fs.existsSync(linked)).toBe(true);
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    try {
      const response = await request(id, action, { confirmed: true, token: 'a'.repeat(64) });
      const body = await response.json();
      const encoded = JSON.stringify(body);
      expect(response.status).toBe(503);
      expect(body.code).toBe('git-unavailable');
      expect(body.error).toBe(gitModule.GIT_UNAVAILABLE_MESSAGE);
      expect(encoded).not.toContain(linked);
      expect(encoded).not.toContain(repo);
      expect(encoded).not.toContain(gitdir);
      expect(encoded).not.toMatch(/\.git\/worktrees|origin\/|https?:/);
      expect(logged.join('\n')).toContain(gitdir);
    } finally { logSpy.mockRestore(); }
  });

  it.each(['preview', 'clean'] as const)('reports spawn ENOTDIR as git-unavailable without a path on %s', async (action) => {
    const id = await register(repo);
    const target = repo;
    fs.rmSync(target, { recursive: true, force: true });
    fs.writeFileSync(target, 'not a directory\n');
    const response = await request(id, action, { confirmed: true, token: 'a'.repeat(64) });
    const body = await response.json();
    const encoded = JSON.stringify(body);
    expect(response.status).toBe(503);
    expect(body.code).toBe('git-unavailable');
    expect(body.error).toBe(gitModule.GIT_UNAVAILABLE_MESSAGE);
    expect(encoded).not.toContain(target);
    expect(encoded).not.toContain(root);
    expect(encoded).not.toMatch(/ENOTDIR|EACCES|spawn/);
  });

  it.skipIf(runningAsRoot).each(['preview', 'clean'] as const)('reports spawn EACCES as git-unavailable without a path on %s', async (action) => {
    const id = await register(repo);
    const target = repo;
    fs.chmodSync(target, 0);
    try {
      expect(await gitSpawnCode(target)).toBe('EACCES');
      const response = await request(id, action, { confirmed: true, token: 'a'.repeat(64) });
      const body = await response.json();
      const encoded = JSON.stringify(body);
      expect(response.status).toBe(503);
      expect(body.code).toBe('git-unavailable');
      expect(body.error).toBe(gitModule.GIT_UNAVAILABLE_MESSAGE);
      expect(encoded).not.toContain(target);
      expect(encoded).not.toContain(root);
      expect(encoded).not.toMatch(/ENOTDIR|EACCES|spawn/);
    } finally {
      fs.chmodSync(target, 0o755);
    }
  });

  it('reports Git failure on worktree preview as git-unavailable', async () => {
    const id = await register(repo);
    fs.renameSync(path.join(repo, '.git'), path.join(repo, '.git-hidden'));
    try {
      const response = await request(id, 'preview');
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe('git-unavailable');
    } finally {
      fs.renameSync(path.join(repo, '.git-hidden'), path.join(repo, '.git'));
    }
  });

  it.each([
    ['UU', () => {
      git(repo, 'checkout', '-b', 'topic');
      fs.writeFileSync(path.join(repo, 'README.md'), 'Topic\n');
      git(repo, 'commit', '-am', 'Topic');
      git(repo, 'checkout', 'main');
      fs.writeFileSync(path.join(repo, 'README.md'), 'Main\n');
      git(repo, 'commit', '-am', 'Main');
      expect(() => git(repo, 'merge', 'topic')).toThrow();
    }],
    ['AA', () => {
      git(repo, 'checkout', '-b', 'add-a');
      fs.writeFileSync(path.join(repo, 'added.txt'), 'From topic\n');
      git(repo, 'add', 'added.txt');
      git(repo, 'commit', '-m', 'Add on topic');
      git(repo, 'checkout', 'main');
      fs.writeFileSync(path.join(repo, 'added.txt'), 'From main\n');
      git(repo, 'add', 'added.txt');
      git(repo, 'commit', '-m', 'Add on main');
      expect(() => git(repo, 'merge', 'add-a')).toThrow();
    }],
  ])('refuses a real %s conflict and does not create a stash', async (status, setup) => {
    const id = await register(repo);
    setup();
    expect(git(repo, 'status', '--porcelain')).toContain(status);
    const preview = await request(id, 'preview');
    expect(preview.status).toBe(409);
    expect((await preview.json()).error).toMatch(/conflito/i);
    const cleaned = await request(id, 'clean', { confirmed: true, token: 'a'.repeat(64) });
    expect(cleaned.status).toBe(409);
    expect(git(repo, 'stash', 'list')).toBe('');
    expect(git(repo, 'status', '--porcelain')).toContain(status);
  });

  it('rejects a cross-site text/plain POST on preview and clean before it can stash', async () => {
    const id = await register(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'Dirty\n');
    const preview = await (await request(id, 'preview')).json();
    for (const action of ['preview', 'clean'] as const) {
      const response = await rawRequest(id, action, {
        origin: 'https://evil.example',
        contentType: 'text/plain',
        body: JSON.stringify({ confirmed: true, token: preview.token }),
      });
      const payload = await response.json();
      expect(response.status).toBe(403);
      expect(payload.error).toMatch(/origem/i);
      expect(payload.token).toBeUndefined();
      expect(payload.files).toBeUndefined();
    }
    expect(git(repo, 'stash', 'list')).toBe('');
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('Dirty\n');
    const open = await fetch(`http://127.0.0.1:${server.port}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repo }),
    });
    expect(open.status).toBe(200);
  });

  it('rejects JSON from an external origin and text/plain from the app origin', async () => {
    const id = await register(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'Dirty\n');
    for (const action of ['preview', 'clean'] as const) {
      const foreign = await rawRequest(id, action, { origin: 'https://evil.example', contentType: 'application/json', body: JSON.stringify({ confirmed: true, token: 'abc' }) });
      expect(foreign.status).toBe(403);
      await foreign.arrayBuffer();
      const plain = await rawRequest(id, action, { origin: `http://127.0.0.1:${server.port}`, contentType: 'text/plain', body: JSON.stringify({ confirmed: true, token: 'abc' }) });
      expect(plain.status).toBe(415);
      await plain.arrayBuffer();
      const missing = await rawRequest(id, action, { origin: null, contentType: 'application/json' });
      expect(missing.status).toBe(403);
      await missing.arrayBuffer();
    }
    expect(git(repo, 'stash', 'list')).toBe('');
    const allowed = await rawRequest(id, 'preview', { origin: `http://localhost:${server.port}`, contentType: 'application/json; charset=utf-8' });
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).files.length).toBeGreaterThan(0);
  });

  it('emits project.worktree.cleaned when the stash exists but the backup hash cannot be read', async () => {
    const id = await register(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'Dirty\n');
    const preview = await (await request(id, 'preview')).json();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const events: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => events.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    const originalGit = gitModule.git;
    const gitSpy = vi.spyOn(gitModule, 'git').mockImplementation((cwd: string, ...args: string[]) => {
      if (args[0] === 'reflog' || (args[0] === 'stash' && args[1] === 'list')) return Promise.resolve('not-a-hash\0unrelated');
      return originalGit(cwd, ...args);
    });
    try {
      const response = await request(id, 'clean', { confirmed: true, token: preview.token });
      expect(gitSpy).toHaveBeenCalled();
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toMatch(/stash/i);
      expect(body.backup).toBeUndefined();
      expect(body.error).not.toMatch(/[0-9a-f]{40}/);
      await vi.waitFor(() => expect(events).toContainEqual({ type: 'project.worktree.cleaned', projectId: id }));
      expect(git(repo, 'stash', 'list')).toContain('gantry-harness-cleanup-');
      expect(git(repo, 'status', '--porcelain')).toBe('');
    } finally { gitSpy.mockRestore(); ws.close(); }
  });

  it('returns the backup when confirmation fails after stashing staged and untracked files', async () => {
    const id = await register(repo);
    const head = git(repo, 'rev-parse', 'HEAD');
    const branch = git(repo, 'branch', '--show-current');
    fs.writeFileSync(path.join(repo, 'README.md'), 'Staged\n');
    git(repo, 'add', 'README.md');
    fs.writeFileSync(path.join(repo, 'extra.txt'), 'Untracked\n');
    fs.writeFileSync(path.join(repo, 'ignored.log'), 'Keep ignored\n');
    const preview = await (await request(id, 'preview')).json();
    expect(preview.files.map((file: { path: string }) => file.path).sort()).toEqual(['README.md', 'extra.txt']);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const events: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => events.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    const originalGit = gitModule.git;
    const originalStatus = gitModule.readWorktreeStatus;
    let pushed = false;
    const gitSpy = vi.spyOn(gitModule, 'git').mockImplementation((cwd: string, ...args: string[]) => {
      if (args[0] === 'stash' && args[1] === 'push') {
        return originalGit(cwd, ...args).then(output => { pushed = true; return output; });
      }
      if (pushed && args[0] === 'reflog') return Promise.reject(new gitModule.GitError('Não foi possível executar o Git: verifique o repositório.'));
      return originalGit(cwd, ...args);
    });
    const statusSpy = vi.spyOn(gitModule, 'readWorktreeStatus').mockImplementation(cwd => {
      if (pushed) return Promise.reject(new gitModule.GitError('Não foi possível executar o Git: verifique o repositório.'));
      return originalStatus(cwd);
    });
    try {
      const response = await request(id, 'clean', { confirmed: true, token: preview.token });
      const body = await response.json();
      const backup = git(repo, 'rev-parse', 'refs/stash');
      expect(gitSpy).toHaveBeenCalled();
      expect(statusSpy).toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(body).toEqual({ backup, clean: false, verified: false });
      expect(JSON.stringify(body)).not.toContain(repo);
      const stashed = git(repo, 'stash', 'show', '--include-untracked', '--name-only', backup);
      expect(stashed).toContain('README.md');
      expect(stashed).toContain('extra.txt');
      await vi.waitFor(() => expect(events).toContainEqual({ type: 'project.worktree.cleaned', projectId: id }));
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(repo, 'branch', '--show-current')).toBe(branch);
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(git(repo, 'diff', '--cached')).toBe('');
      expect(git(repo, 'stash', 'list').split('\n').filter(Boolean)).toHaveLength(1);
      expect(fs.readFileSync(path.join(repo, 'ignored.log'), 'utf8')).toBe('Keep ignored\n');
      git(repo, 'stash', 'apply', '--index', backup);
      expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('Staged\n');
      expect(fs.readFileSync(path.join(repo, 'extra.txt'), 'utf8')).toBe('Untracked\n');
      expect(git(repo, 'diff', '--cached')).toContain('Staged');
    } finally { gitSpy.mockRestore(); statusSpy.mockRestore(); ws.close(); }
  });

  it('returns the backup when stash push exits after saving staged and untracked files', async () => {
    const id = await register(repo);
    const head = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'README.md'), 'Staged\n');
    git(repo, 'add', 'README.md');
    const locked = path.join(repo, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'note.txt'), 'secret\n');
    fs.chmodSync(locked, 0o555);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const events: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => events.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    try {
      const preview = await (await request(id, 'preview')).json();
      expect(preview.files.map((file: { path: string }) => file.path).sort()).toEqual(['README.md', 'locked/note.txt']);
      const response = await request(id, 'clean', { confirmed: true, token: preview.token });
      const body = await response.json();
      const backup = git(repo, 'rev-parse', 'refs/stash');
      expect(response.status).toBe(200);
      expect(body).toEqual({
        backup,
        clean: false,
        verified: false,
        keep: ['README.md'],
      });
      expect(body.restore).toBeUndefined();
      expect(body.remove).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(repo);
      expect(body.keep.every((file: string) => !path.isAbsolute(file))).toBe(true);
      let blocked = '';
      try {
        git(repo, 'stash', 'apply', '--index', backup);
      } catch (error) {
        blocked = String((error as { stderr?: string }).stderr ?? error);
      }
      expect(blocked).toMatch(/already exists, no checkout/);
      expect(git(repo, 'rev-parse', 'refs/stash')).toBe(backup);
      expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('Staged\n');
      expect(git(repo, 'show', ':README.md')).toBe('Staged');
      expect(fs.readFileSync(path.join(locked, 'note.txt'), 'utf8')).toBe('secret\n');
      expect(git(repo, 'diff', '--cached')).toContain('Staged');
      expect(git(repo, 'rev-parse', 'refs/stash')).toBe(backup);
      expect(git(repo, 'stash', 'list').split('\n').filter(Boolean)).toHaveLength(1);
      const stashed = git(repo, 'stash', 'show', '--include-untracked', '--name-only', backup);
      expect(stashed).toContain('README.md');
      expect(stashed).toContain('locked/note.txt');
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(repo, 'status', '--porcelain')).toContain('README.md');
      expect(git(repo, 'status', '--porcelain')).toContain('locked/');
      await vi.waitFor(() => expect(events).toContainEqual({ type: 'project.worktree.cleaned', projectId: id }));
    } finally {
      fs.chmodSync(locked, 0o755);
      ws.close();
    }
  });

  it('follows the displayed recovery and restores staged, unstaged, and untracked content', async () => {
    const id = await register(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'Tracked base\n');
    git(repo, 'add', 'tracked.txt');
    git(repo, 'commit', '-m', 'Track a second file');
    fs.writeFileSync(path.join(repo, 'README.md'), 'Staged line\n');
    git(repo, 'add', 'README.md');
    fs.writeFileSync(path.join(repo, 'README.md'), 'Staged line\nUnstaged line\n');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'Unstaged only\n');
    const locked = path.join(repo, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'extra.txt'), 'extra\n');
    fs.writeFileSync(path.join(locked, 'note.txt'), 'note\n');
    fs.writeFileSync(path.join(locked, 'f'), 'f\n');
    fs.writeFileSync(path.join(repo, 'u1'), 'u1-bytes\n');
    fs.writeFileSync(path.join(repo, '-lead'), 'lead-bytes\n');
    fs.mkdirSync(path.join(repo, 'dir sp'));
    const quoted = path.join(repo, 'dir sp', "it's -x.txt");
    fs.writeFileSync(quoted, 'quote-bytes\n');
    fs.chmodSync(locked, 0o555);
    const read = (file: string) => fs.readFileSync(path.join(repo, file));
    const gitBytes = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', ...args], { cwd: repo });
    const files = ['README.md', 'tracked.txt', 'locked/extra.txt', 'locked/note.txt', 'locked/f', 'u1', '-lead', "dir sp/it's -x.txt"];
    const original = {
      files: Object.fromEntries(files.map(file => [file, read(file)])),
      indexReadme: gitBytes('show', ':README.md'),
      indexTracked: gitBytes('show', ':tracked.txt'),
      staged: gitBytes('diff', '--cached'),
      unstaged: gitBytes('diff'),
    };
    try {
      const preview = await (await request(id, 'preview')).json();
      const response = await request(id, 'clean', { confirmed: true, token: preview.token });
      const body = await response.json();
      const backup = git(repo, 'rev-parse', 'refs/stash');
      expect(response.status).toBe(200);
      expect(body.verified).toBe(false);
      expect(body.keep).toEqual(['README.md', 'tracked.txt']);
      expect(body.remove).toBeUndefined();
      expect(body.restore).toBe(`git restore --source '${backup}^3' --worktree -- '-lead' 'dir sp/it'\\''s -x.txt' 'u1'`);
      expect(body.restore).not.toMatch(/README\.md|tracked\.txt|locked\//);
      expect(JSON.stringify(body)).not.toContain(repo);
      for (const file of ['u1', '-lead', "dir sp/it's -x.txt"]) expect(fs.existsSync(path.join(repo, file))).toBe(false);
      for (const file of body.keep as string[]) expect(fs.existsSync(path.join(repo, file))).toBe(true);
      expect(fs.readFileSync(path.join(locked, 'f'), 'utf8')).toBe('f\n');
      execFileSync('sh', ['-c', body.restore], { cwd: repo, stdio: 'pipe' });
      for (const file of files) expect(read(file)).toEqual(original.files[file]);
      expect(gitBytes('show', ':README.md')).toEqual(original.indexReadme);
      expect(gitBytes('show', ':tracked.txt')).toEqual(original.indexTracked);
      expect(gitBytes('diff', '--cached')).toEqual(original.staged);
      expect(gitBytes('diff')).toEqual(original.unstaged);
      expect(git(repo, 'rev-parse', 'refs/stash')).toBe(backup);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

});
