import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../src/server/app.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('serves installed assets independently of cwd and manages native PTY sizing and closure', async () => {
  if (process.platform !== 'win32') vi.stubEnv('SHELL', '/bin/sh');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-desktop-'));
  const client = path.join(root, 'installed-client');
  fs.mkdirSync(path.join(client, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(client, 'index.html'), '<html>Installed desktop client</html>');
  fs.writeFileSync(path.join(client, 'assets', 'entry.js'), 'window.desktop = true;');
  const server = await createHarnessServer({ gantryHome: path.join(root, 'home'), clientDistDir: client + path.sep, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    expect(await (await fetch(base)).text()).toContain('Installed desktop client');
    expect(await (await fetch(base + '/assets/entry.js')).text()).toContain('window.desktop');
    const registration = await (await post('/api/projects', { path: root })).json();
    const projectId = registration.project.id;
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1EAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(path.join(root, 'diagram.png'), image);
    const imageResponse = await fetch(`${base}/api/projects/${projectId}/artifact-assets?path=diagram.png`);
    expect(imageResponse.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await imageResponse.arrayBuffer())).toEqual(image);
    expect((await fetch(`${base}/api/projects/${projectId}/artifact-assets?path=${encodeURIComponent('../outside.png')}`)).status).toBe(403);
    fs.writeFileSync(path.join(root, 'private.txt'), 'not an image');
    expect((await fetch(`${base}/api/projects/${projectId}/artifact-assets?path=private.txt`)).status).toBe(415);
    if (process.platform !== 'win32') {
      fs.symlinkSync(os.tmpdir(), path.join(root, 'outside-images'));
      expect((await fetch(`${base}/api/projects/${projectId}/artifact-assets?path=outside-images/outside.png`)).status).toBe(404);
      fs.symlinkSync(os.tmpdir(), path.join(root, 'outside-directory.png'));
      expect((await fetch(`${base}/api/projects/${projectId}/artifact-assets?path=outside-directory.png`)).status).toBe(403);
    }
    expect((await post(`/api/projects/${projectId}/commands/prepare`, { command: 'plan', request: 'Build login' })).status).toBe(404);
    expect((await post(`/api/projects/${projectId}/plan/start`, { goal: 'login' })).status).toBe(404);
    expect((await post(`/api/projects/${projectId}/run`, { scope: 'all' })).status).toBe(404);
    expect((await fetch(`${base}/api/projects/${projectId}/kanban`)).status).toBe(404);
    expect((await post(`/api/projects/${projectId}/runs/run-1/steer`, { issueRef: 'x', instruction: 'now' })).status).toBe(404);
    expect((await post(`/api/projects/${projectId}/runs/run-1/takeover`, { issueRef: 'x', worktreePath: root })).status).toBe(404);
    expect((await post(`/api/projects/${projectId}/runs/run-1/cleanup`, { rawPlanJson: {} })).status).toBe(404);
    const panes = `/api/projects/${projectId}/panes`;
    const start = await post(panes, { launcher: 'shell', paneId: 'native' });
    expect(start.status).toBe(200);
    expect((await start.json()).pane.status).toBe('running');
    const resize = await post(panes + '/native/resize', { cols: 123, rows: 41 });
    expect(resize.status).toBe(200);
    expect((await resize.json()).pane).toMatchObject({ cols: 123, rows: 41 });
    expect((await post(panes + '/native/resize', { cols: -1, rows: 0 })).ok).toBe(false);
    if (process.platform !== 'win32') {
      await post(panes + '/native/input', { data: 'stty size\r' });
      await vi.waitFor(async () => {
        const pane = await (await fetch(base + panes + '/native')).json();
        expect(pane.pane.terminalBuffer).toMatch(/41\s+123/);
      });
    }
    expect((await fetch(base + panes + '/native', { method: 'DELETE' })).ok).toBe(true);
    expect((await (await fetch(base + panes)).json()).panes).toHaveLength(0);
  } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
