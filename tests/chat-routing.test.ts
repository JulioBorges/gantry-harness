import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarnessServer, type HarnessServerInstance } from '../src/server/app.js';

let root: string;
let repo: string;
let profileRoot: string;
let callsPath: string;
let server: HarnessServerInstance;
let projectId: string;
let sessionId: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-chat-'));
  repo = path.join(root, 'repo');
  profileRoot = path.join(root, 'profiles');
  callsPath = path.join(root, 'calls.jsonl');
  fs.mkdirSync(path.join(repo, '.gantry'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.gantry', 'config.json'), JSON.stringify({ execution: { hostHarness: 'codex', roles: { plan: { harness: 'codex', model: 'do-not-borrow-this-model' } } } }));
  fs.writeFileSync(path.join(repo, 'README.md'), '# Repository context marker');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['codex', 'claude']) {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ host: ${JSON.stringify(name)}, args: process.argv.slice(2), input, cwd: process.cwd() }) + '\\n');
if (input.includes('FAIL_THIS_REQUEST')) { console.error('fixture authentication failure'); process.exit(1); }
console.log('host response: ' + input.slice(input.lastIndexOf('Operator message:')));
`, { mode: 0o755 });
  }
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  server = await createHarnessServer({ gantryHome: path.join(root, 'home'), profileRoot, port: 0 });
  const registered = server.store.upsertProject({ path: repo, unitId: 'fixture-unit' });
  projectId = registered.project.id;
  sessionId = registered.defaultSessionId;
});

afterEach(async () => {
  await server.close();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const request = (route: string, body?: unknown) => fetch(`http://127.0.0.1:${server.port}${route}`, body === undefined ? undefined : {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

it('does not connect a host through a conversation endpoint', async () => {
  const response = await request(`/api/projects/${projectId}/chat`, { sessionId, prompt: 'hello from the conversation screen' });
  expect(response.status).toBe(404);
  expect(fs.existsSync(callsPath)).toBe(false);
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
