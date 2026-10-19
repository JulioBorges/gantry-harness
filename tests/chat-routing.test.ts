import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarnessServer, type HarnessServerInstance } from '../src/server/app.js';

let root: string;
let repo: string;
let server: HarnessServerInstance;
let projectId: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-chat-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.gantry'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.gantry', 'config.json'), JSON.stringify({ execution: { hostHarness: 'codex' } }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['codex', 'claude']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  server = await createHarnessServer({ gantryHome: path.join(root, 'home'), profileRoot: path.join(root, 'profiles'), port: 0 });
  projectId = server.store.upsertProject({ path: repo, unitId: 'fixture-unit' }).project.id;
});

afterEach(async () => {
  await server.close();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const request = (route: string, body?: unknown) => fetch(`http://127.0.0.1:${server.port}${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

it('launches the requested agent executable in a real terminal instead of substituting a shell', async () => {
  const response = await request(`/api/projects/${projectId}/panes`, { launcher: 'codex', paneId: 'agent' });
  expect(response.status).toBe(200);
  const { pane } = await response.json();
  expect(pane.command).toEqual([path.join(root, 'bin', 'codex')]);
  expect(pane.worktreePath).toBe(repo);
});

it('refuses an unavailable launcher without silently opening a shell', async () => {
  const response = await request(`/api/projects/${projectId}/panes`, { launcher: 'not-a-host', paneId: 'bad' });
  expect(response.status).toBe(500);
  expect((await response.json()).error).toContain('não suportado');
});
