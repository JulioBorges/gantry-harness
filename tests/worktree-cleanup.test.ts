import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHarnessServer, type HarnessServerInstance } from '../src/server/app.js';

let root: string;
let repo: string;
let server: HarnessServerInstance;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
function initRepo(name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Cleanup test');
  git(dir, 'config', 'user.email', 'cleanup@example.test');
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
  return fetch(`http://127.0.0.1:${server.port}/api/projects/${id}/worktree/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-cleanup-test-'));
  repo = initRepo('project');
  server = await createHarnessServer({ port: 0, gantryHome: path.join(root, 'home'), homeDir: root, stateRoot: path.join(root, 'state'), profileRoot: path.join(root, 'profiles') });
});
afterEach(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }); });

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

});
