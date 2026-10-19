import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarnessServer, type HarnessServerInstance } from '../src/server/app.js';
import { shellDefinitions, resolveTerminalShell } from '../src/server/terminalSettings.js';

let root: string;
let server: HarnessServerInstance;
let projectId: string;
const settings = { fontFamily: '"Fira Code", monospace', fontSize: 18, shell: process.platform === 'win32' ? 'cmd' : 'sh' };
const start = () => createHarnessServer({ gantryHome: path.join(root, 'home'), profileRoot: path.join(root, 'profiles'), port: 0 });
const request = (route: string, body?: unknown, method = 'PUT') => fetch(`http://127.0.0.1:${server.port}${route}`, body === undefined ? undefined : {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-terminal-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  server = await start();
  projectId = server.store.upsertProject({ path: repo, unitId: 'fixture' }).project.id;
});
afterEach(async () => { await server.close(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

it.each([
  ['linux', ['bash', 'sh']], ['darwin', ['zsh', 'bash', 'sh']], ['win32', ['cmd', 'powershell', 'pwsh']],
])('offers native shell choices for %s', (platform, expected) => {
  expect(shellDefinitions(platform).map(({ id }) => id)).toEqual(expected);
});

it('loads native options and persists terminal preferences independently of the coordinator across restart', async () => {
  const state = await request('/api/workspace/state').then((res) => res.json());
  expect(state.terminalSettings).toMatchObject({ fontSize: 13, shell: 'system' });
  expect(state.terminalEnvironment.platform).toBe(process.platform);
  expect(state.terminalEnvironment.shells.map((item: { id: string }) => item.id)).toEqual(['system', ...shellDefinitions(process.platform).map(({ id }) => id)]);
  expect((await request('/api/settings/providers')).status).toBe(404);
  expect((await request('/api/settings/terminal', settings)).status).toBe(200);
  await server.close();
  server = await start();
  expect(server.store.getTerminalSettings()).toEqual(settings);
  expect(fs.existsSync(path.join(root, 'home', 'harness', 'settings.json'))).toBe(false);
});

it('applies the chosen shell to new PTYs while preserving an open shell and accepting arbitrary commands', async () => {
  const route = `/api/projects/${projectId}/panes`;
  const { pane: first } = await request(route, { launcher: 'shell', paneId: 'before' }, 'POST').then((res) => res.json());
  expect(first.command).toEqual(resolveTerminalShell('system'));
  await request('/api/settings/terminal', settings);
  const { pane: second } = await request(route, { launcher: 'shell', paneId: 'after' }, 'POST').then((res) => res.json());
  expect(second.command).toEqual(resolveTerminalShell(settings.shell as 'cmd' | 'sh'));
  const before = await request(`${route}/before`).then((res) => res.json());
  expect(before.pane.command).toEqual(first.command);
  expect(before.pane.status).toBe('running');
  await request(`${route}/after/input`, { data: `node -e "console.log('SHELL_COMMAND_OK', process.cwd())"\r` }, 'POST');
  await vi.waitFor(async () => {
    const { pane } = await request(`${route}/after`).then((res) => res.json());
    expect(pane.terminalBuffer).toContain(`SHELL_COMMAND_OK ${fs.realpathSync(path.join(root, 'repo'))}`);
  });
});

it.each([
  { ...settings, fontSize: 0 }, { ...settings, fontSize: 41 }, { ...settings, fontSize: 13.5 },
  { ...settings, fontFamily: '' }, { ...settings, fontFamily: 'font\nname' },
  { ...settings, shell: 'codex' }, { ...settings, shell: 'sh; codex resume' },
  { ...settings, shell: process.platform === 'win32' ? 'zsh' : 'powershell' },
])('rejects invalid settings without overwriting saved preferences: %j', async (input) => {
  await request('/api/settings/terminal', settings);
  const response = await request('/api/settings/terminal', input);
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBeTruthy();
  expect(server.store.getTerminalSettings()).toEqual(settings);
});

it('reports a missing system shell without substituting an agent', async () => {
  vi.stubEnv(process.platform === 'win32' ? 'COMSPEC' : 'SHELL', path.join(root, 'missing-shell'));
  const response = await request(`/api/projects/${projectId}/panes`, { launcher: 'shell' }, 'POST');
  expect(response.status).toBe(500);
  expect((await response.json()).error).toContain('não encontrado');
});
