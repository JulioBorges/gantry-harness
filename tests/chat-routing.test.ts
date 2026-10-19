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
  server.store.updateProviderSettings({ mode: 'cli', activeProvider: 'cli', cliHarness: 'opencode', providers: { cli: { model: 'another-host-model' } } });
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

it('routes chat to the saved project host with repository context and conversation history', async () => {
  const state = await request('/api/workspace/state').then((res) => res.json());
  expect(state.connection).toMatchObject({ host: 'codex', source: 'repository', model: null, ready: true });
  const first = await request(`/api/projects/${projectId}/chat`, { sessionId, prompt: 'first question' });
  expect(first.status).toBe(200);
  const second = await request(`/api/projects/${projectId}/chat`, { sessionId, prompt: 'follow-up question' });
  expect(second.status).toBe(200);
  expect((await second.json()).assistantMessage.content).toContain('follow-up question');
  const calls = fs.readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ host: 'codex', cwd: fs.realpathSync(repo) });
  expect(calls[1].input).toContain('first question');
  expect(calls[1].input).toContain('Repository context marker');
  expect(calls[1].args).not.toContain('do-not-borrow-this-model');
  expect(calls[1].args).not.toContain('another-host-model');
});

it('uses the model saved for the project host even when the global host is different', async () => {
  server.store.updateProviderSettings({
    mode: 'cli', activeProvider: 'cli', cliHarness: 'opencode',
    providers: { cli: { model: 'another-host-model', modelsByHost: { codex: 'gpt-5.2-codex', opencode: 'another-host-model' } } },
  });
  const state = await request('/api/workspace/state').then((res) => res.json());
  expect(state.connection).toMatchObject({ host: 'codex', model: 'gpt-5.2-codex', source: 'repository' });
  const response = await request(`/api/projects/${projectId}/chat`, { sessionId, prompt: 'use the configured model' });
  expect(response.status).toBe(200);
  const call = JSON.parse(fs.readFileSync(callsPath, 'utf8').trim().split('\n').at(-1)!);
  expect(call.host).toBe('codex');
  expect(call.args).toContain('--model');
  expect(call.args).toContain('gpt-5.2-codex');
  expect(call.args).not.toContain('another-host-model');
});

it('honors the saved personal host without rewriting the repository policy', async () => {
  fs.mkdirSync(path.join(profileRoot, 'fixture-unit'), { recursive: true });
  fs.writeFileSync(path.join(profileRoot, 'fixture-unit', 'execution.json'), JSON.stringify({ hostHarness: 'claude' }));
  const response = await request(`/api/projects/${projectId}/chat`, { sessionId, prompt: 'profile request' });
  expect(response.status).toBe(200);
  expect((await response.json()).connection).toMatchObject({ host: 'claude', source: 'profile' });
  expect(JSON.parse(fs.readFileSync(callsPath, 'utf8')).host).toBe('claude');
  expect(fs.readFileSync(path.join(repo, '.gantry', 'config.json'), 'utf8')).toContain('codex');
});

it('returns a visible upstream error and never persists a fabricated assistant reply', async () => {
  const response = await request(`/api/projects/${projectId}/chat`, { sessionId, prompt: 'FAIL_THIS_REQUEST' });
  expect(response.status).toBe(502);
  expect((await response.json()).error).toContain('fixture authentication failure');
  expect(server.store.listMessages(projectId, sessionId).map((message) => message.role)).toEqual(['user']);
});

it('rejects an empty message before calling a host and keeps a stale session on this project', async () => {
  expect((await request(`/api/projects/${projectId}/chat`, { sessionId, prompt: '' })).status).toBe(400);
  expect(fs.existsSync(callsPath)).toBe(false);
  const response = await request(`/api/projects/${projectId}/chat`, { sessionId: 'wrong-session', prompt: 'hello from the open project' });
  expect(response.status).toBe(200);
  expect(server.store.listMessages(projectId, sessionId).some((message) => message.content === 'hello from the open project')).toBe(true);
  const call = JSON.parse(fs.readFileSync(callsPath, 'utf8').trim().split('\n').at(-1)!);
  expect(call.host).toBe('codex');
});

it('reports invalid saved configuration without falling back to a global host', async () => {
  fs.writeFileSync(path.join(repo, '.gantry', 'config.json'), JSON.stringify({ execution: { hostHarness: 'unknown-host' } }));
  const state = await request('/api/workspace/state').then((response) => response.json());
  expect(state.connection.ready).toBe(false);
  expect(state.connection.detail).toContain('unknown-host');
  const response = await request(`/api/projects/${projectId}/chat`, { sessionId, prompt: 'hello' });
  expect(response.status).toBe(400);
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
