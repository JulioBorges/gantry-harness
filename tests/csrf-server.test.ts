import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { runCli } from '../src/cli.js';
import { createHarnessServer, type HarnessServerInstance } from '../src/server/app.js';
import { isLoopbackRemote } from '../src/server/stateChangeGuard.js';
import { STATE_CHANGING_METHOD_CHECKS, STATE_CHANGING_ROUTES } from '../src/server/stateChangingRoutes.js';
import { nativeFetch } from './setup-app-origin.js';

interface RawResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function rawHttp(port: number, method: string, requestPath: string, headers: Record<string, string>, hostname = '127.0.0.1'): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, method, path: requestPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function websocketUpgrade(port: number, headers: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (res) => {
      const responseHeaders = res.headers;
      res.socket.destroy();
      resolve({ status: res.statusCode ?? 101, body: '', headers: responseHeaders });
    });
    req.on('response', (res) => {
      const responseHeaders = res.headers;
      res.resume();
      resolve({ status: res.statusCode ?? 0, body: '', headers: responseHeaders });
    });
    req.on('error', reject);
    req.end();
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function listPairingCodes(dbPath: string): Array<{ code: string; used: number }> {
  const requireRuntime = createRequire(import.meta.url);
  const db = process.versions.bun
    ? new (requireRuntime('bun:sqlite').Database)(dbPath, { readonly: true })
    : new (requireRuntime('node:sqlite').DatabaseSync)(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT code, used FROM pairing_codes ORDER BY code').all() as Array<{ code: string; used: number }>;
  } finally {
    db.close();
  }
}

function lanAddress(): string | undefined {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

const appSource = fs.readFileSync(fileURLToPath(new URL('../src/server/app.ts', import.meta.url)), 'utf8');

describe('server-wide state-change protection', () => {
  let server: HarnessServerInstance | undefined;
  let root: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('keeps every registered state-changing route behind the central guard', () => {
    const guardAt = appSource.indexOf('if (isStateChangingMethod(req.method))');
    expect(guardAt).toBeGreaterThan(0);
    expect(appSource.slice(0, guardAt)).not.toMatch(/req\.method === '(?:POST|PUT|PATCH|DELETE)'/);
    expect(appSource).not.toContain('Access-Control-Allow-Origin');

    const lines = appSource.split('\n');
    const checks = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /req\.method === '(?:POST|PUT|PATCH|DELETE)'/.test(line));
    expect(checks).toHaveLength(STATE_CHANGING_METHOD_CHECKS);

    const covered = new Set<string>();
    for (const check of checks) {
      const window = lines.slice(Math.max(0, check.index - 20), check.index + 1).join('\n');
      const hits = STATE_CHANGING_ROUTES.filter((route) => window.includes(route.marker));
      expect(hits, window).not.toHaveLength(0);
      for (const hit of hits) covered.add(hit.path);
    }
    expect([...covered].sort()).toEqual(STATE_CHANGING_ROUTES.map((route) => route.path).sort());

    const verifyAt = appSource.indexOf("pathname === '/api/auth/pair/verify'");
    const remoteAt = appSource.indexOf('options.requirePairingForRemote && isRemoteRequest');
    expect(guardAt).toBeLessThan(verifyAt);
    expect(verifyAt).toBeLessThan(remoteAt);
  });

  it('refuses a cross-site text/plain POST on every state-changing route, including CLI dispatch', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-csrf-'));
    server = await createHarnessServer({
      gantryHome: path.join(root, 'home'),
      stateRoot: path.join(root, 'state'),
      profileRoot: path.join(root, 'profiles'),
      port: 0,
    });
    const base = `http://127.0.0.1:${server.port}`;

    for (const route of STATE_CHANGING_ROUTES) {
      const response = await nativeFetch(`${base}${route.path}`, {
        method: route.method,
        headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
        body: '{}',
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      expect(await response.json()).toEqual({ error: 'Origem recusada.' });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }

    const forgedDispatch = await nativeFetch(`${base}/api/cli/dispatch`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: root }),
    });
    expect(forgedDispatch.status).toBe(403);
    expect(server.store.listProjects()).toHaveLength(0);

    const unregistered = await nativeFetch(`${base}/api/cli/dispatch`, {
      method: 'PATCH',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(unregistered.status).toBe(403);

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const requestPath = `/api/${crypto.randomUUID()}/missing-${method.toLowerCase()}`;
      const response = await nativeFetch(`${base}${requestPath}`, {
        method,
        headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
        body: '{}',
      });
      expect(response.status, `${method} ${requestPath}`).toBe(403);
      expect(await response.json()).toEqual({ error: 'Origem recusada.' });
    }
  });

  it('accepts the app origin with JSON and no longer advertises Access-Control-Allow-Origin', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-csrf-ok-'));
    server = await createHarnessServer({
      gantryHome: path.join(root, 'home'),
      stateRoot: path.join(root, 'state'),
      profileRoot: path.join(root, 'profiles'),
      port: 0,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const origin = base;

    const wrongType = await nativeFetch(`${base}/api/cli/dispatch`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ cwd: root }),
    });
    expect(wrongType.status).toBe(415);
    expect(await wrongType.json()).toEqual({ error: 'Content-Type deve ser application/json.' });
    expect(wrongType.headers.get('access-control-allow-origin')).toBeNull();

    const missingOrigin = await nativeFetch(`${base}/api/cli/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: root }),
    });
    expect(missingOrigin.status).toBe(403);

    const allowed = await nativeFetch(`${base}/api/cli/dispatch`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: root }),
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBeNull();
    expect((await allowed.json()).focusedProjectPath).toBe(root);

    for (const pathName of ['/api/health', '/api/projects', '/api/workspace/state']) {
      const response = await nativeFetch(`${base}${pathName}`);
      expect(response.status, pathName).toBe(200);
      expect(response.headers.get('access-control-allow-origin'), pathName).toBeNull();
    }

    const preflight = await nativeFetch(`${base}/api/cli/dispatch`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses a foreign Host on GET and on the WebSocket upgrade', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-csrf-host-'));
    server = await createHarnessServer({
      gantryHome: path.join(root, 'home'),
      stateRoot: path.join(root, 'state'),
      profileRoot: path.join(root, 'profiles'),
      port: 0,
    });
    const port = server.port;
    for (const requestPath of ['/api/projects', '/api/workspace/state']) {
      const foreign = await rawHttp(port, 'GET', requestPath, { Host: 'evil.example' });
      expect(foreign.status, requestPath).toBe(421);
      expect(JSON.parse(foreign.body)).toEqual({ error: 'Host recusado.' });
      const namedPort = await rawHttp(port, 'GET', requestPath, { Host: `evil.example:${port}` });
      expect(namedPort.status, requestPath).toBe(421);
    }
    const accepted = await rawHttp(port, 'GET', '/api/projects', { Host: `127.0.0.1:${port}` });
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body)).toEqual({ projects: [] });

    expect((await websocketUpgrade(port, { Host: `evil.example:${port}` })).status).toBe(421);
    expect((await websocketUpgrade(port, { Host: `127.0.0.1:${port}` })).status).toBe(101);
  });

  it('refuses opaque and wrong-port origins and non-JSON bodies without changing stored state', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-csrf-matrix-'));
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'qa@example.com');
    git(repo, 'config', 'user.name', 'QA');
    fs.writeFileSync(path.join(repo, 'note.txt'), 'antes\n');
    git(repo, 'add', 'note.txt');
    git(repo, 'commit', '-m', 'base');
    fs.writeFileSync(path.join(repo, 'note.txt'), 'depois\n');
    git(repo, 'stash', 'push', '-m', 'qa-backup');

    server = await createHarnessServer({
      gantryHome: path.join(root, 'home'),
      stateRoot: path.join(root, 'state'),
      profileRoot: path.join(root, 'profiles'),
      port: 0,
    });
    const project = server.store.upsertProject({ path: repo, name: 'qa', unitId: 'qa' }).project;
    server.store.updateGlobalExecution({ hostHarness: 'qa-host' });
    server.store.updateTerminalSettings({ fontFamily: 'QA Mono', fontSize: 15, shell: 'system' });
    server.store.saveRun({
      runId: 'run-qa',
      projectId: project.id,
      ref: 'qa#01',
      slug: 'qa',
      kind: 'issue',
      status: 'paused',
      childPid: null,
      pid: null,
      childHandle: null,
      lane: 'implement',
      packPhase: 'implement',
      branch: null,
      worktree: null,
      pushed: false,
      pause: null,
      pausedReason: null,
      pausedChoices: null,
      terminalEvent: null,
      error: null,
      prUrl: null,
      derivedPhase: 'paused',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const pairingCode = server.store.generatePairingCode();
    const base = `http://127.0.0.1:${server.port}`;
    const snapshot = () => ({
      projects: server!.store.listProjects(),
      execution: server!.store.getGlobalExecution(),
      terminal: server!.store.getTerminalSettings(),
      runs: server!.store.listRuns(project.id),
      stash: git(repo, 'stash', 'list'),
      pairingCodes: listPairingCodes(server!.store.dbPath),
    });
    const before = snapshot();
    expect(before.projects).toHaveLength(1);
    expect(before.runs).toHaveLength(1);
    expect(before.stash).toContain('qa-backup');
    expect(before.pairingCodes.map((row) => row.code)).toEqual([pairingCode]);

    const bodies: Record<string, { contentType: string; body: string }> = {
      form: { contentType: 'application/x-www-form-urlencoded', body: 'cwd=%2Ftmp' },
      multipart: {
        contentType: 'multipart/form-data; boundary=----qa',
        body: '------qa\r\nContent-Disposition: form-data; name="cwd"\r\n\r\n/tmp\r\n------qa--\r\n',
      },
    };
    for (const route of STATE_CHANGING_ROUTES) {
      for (const origin of ['null', 'http://127.0.0.1:9']) {
        const response = await nativeFetch(`${base}${route.path}`, {
          method: route.method,
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: '{}',
        });
        expect(response.status, `${origin} ${route.method} ${route.path}`).toBe(403);
        expect(await response.json()).toEqual({ error: 'Origem recusada.' });
      }
      for (const [label, payload] of Object.entries(bodies)) {
        const response = await nativeFetch(`${base}${route.path}`, {
          method: route.method,
          headers: { Origin: base, 'Content-Type': payload.contentType },
          body: payload.body,
        });
        expect(response.status, `${label} ${route.method} ${route.path}`).toBe(415);
        expect(await response.json()).toEqual({ error: 'Content-Type deve ser application/json.' });
      }
    }

    expect(snapshot()).toEqual(before);
  });

  it('omits Access-Control-Allow-Origin on preflight, 404, static files and the WebSocket upgrade', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-csrf-acao-'));
    server = await createHarnessServer({
      gantryHome: path.join(root, 'home'),
      stateRoot: path.join(root, 'state'),
      profileRoot: path.join(root, 'profiles'),
      port: 0,
    });
    const port = server.port;
    const host = `127.0.0.1:${port}`;
    const preflight = await rawHttp(port, 'OPTIONS', '/api/cli/dispatch', {
      Host: host,
      Origin: 'https://evil.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-methods']).toBeUndefined();

    const missing = await rawHttp(port, 'GET', '/api/does-not-exist', { Host: host });
    expect(missing.status).toBe(404);
    expect(missing.headers['access-control-allow-origin']).toBeUndefined();

    const page = await rawHttp(port, 'GET', '/', { Host: host });
    expect(page.status).toBe(200);
    expect(String(page.headers['content-type'])).toContain('text/html');
    expect(page.headers['access-control-allow-origin']).toBeUndefined();

    const upgrade = await websocketUpgrade(port, { Host: host, Origin: `http://${host}` });
    expect(upgrade.status).toBe(101);
    expect(upgrade.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('delivers a broadcast to a WebSocket opened with the app origin', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-csrf-ws-event-'));
    server = await createHarnessServer({
      gantryHome: path.join(root, 'home'),
      port: 0,
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server!.port}`, { headers: { Origin: origin } });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('app-origin websocket did not receive a broadcast'));
      }, 2000);
      ws.on('open', () => server!.broadcast({ type: 'qa.ping', ok: true }));
      ws.on('message', (data) => {
        clearTimeout(timer);
        ws.close();
        resolve(String(data));
      });
      ws.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    expect(JSON.parse(message)).toEqual({ type: 'qa.ping', ok: true });
  });

  it('accepts an IP literal when the server is bound to every interface', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-csrf-ip-'));
    server = await createHarnessServer({
      gantryHome: path.join(root, 'home'),
      stateRoot: path.join(root, 'state'),
      profileRoot: path.join(root, 'profiles'),
      host: '0.0.0.0',
      port: 0,
    });
    const port = server.port;
    const literal = await rawHttp(port, 'GET', '/api/health', { Host: `203.0.113.10:${port}` });
    expect(literal.status).toBe(200);
    expect(JSON.parse(literal.body).status).toBe('ok');
    const named = await rawHttp(port, 'GET', '/api/health', { Host: `evil.example:${port}` });
    expect(named.status).toBe(421);

    const ip = lanAddress();
    if (!ip) return;
    const viaInterface = await rawHttp(port, 'GET', '/api/projects', { Host: `${ip}:${port}` }, ip);
    expect(viaInterface.status).toBe(200);
    expect(JSON.parse(viaInterface.body)).toEqual({ projects: [] });
    const paired = await nativeFetch(`http://${ip}:${port}/api/auth/pair/generate`, {
      method: 'POST',
      headers: { Origin: `http://${ip}:${port}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(paired.status).toBe(200);
    const generated = await paired.json() as { code?: string };
    expect(generated.code).toMatch(/^\d{6}$/);
    expect(listPairingCodes(server.store.dbPath).map((row) => row.code)).toContain(generated.code);
  });

  it('CLI dispatch sends the app origin and JSON without the suite injecting them', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-csrf-cli-'));
    const gantryHome = path.join(root, 'home');
    server = await createHarnessServer({
      gantryHome,
      stateRoot: path.join(root, 'state'),
      profileRoot: path.join(root, 'profiles'),
      port: 0,
    });
    const seen: Array<{ origin: string | null; contentType: string | null }> = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() !== 'GET') {
        const headers = new Headers(init?.headers);
        seen.push({ origin: headers.get('origin'), contentType: headers.get('content-type') });
      }
      return nativeFetch(input, init);
    }) as typeof fetch;
    try {
      const result = await runCli([], { cwd: root, gantryHome, stateRoot: path.join(root, 'state'), profileRoot: path.join(root, 'profiles') });
      expect(result.reusedExistingServer).toBe(true);
      expect(result.focusedProjectPath).toBe(root);
    } finally {
      globalThis.fetch = previous;
    }
    expect(seen).toEqual([{ origin: `http://127.0.0.1:${server.port}`, contentType: 'application/json' }]);
  });

  it('refuses a WebSocket whose Origin is not the app', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-csrf-ws-'));
    server = await createHarnessServer({
      gantryHome: path.join(root, 'home'),
      port: 0,
    });
    const url = `ws://127.0.0.1:${server.port}`;
    await expect(new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: 'https://evil.example' } });
      ws.on('open', () => {
        ws.close();
        reject(new Error('foreign origin websocket opened'));
      });
      ws.on('error', () => resolve());
      ws.on('unexpected-response', () => resolve());
    })).resolves.toBeUndefined();

    await expect(new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('loopback websocket without Origin did not open'));
      }, 2000);
      ws.on('open', () => {
        clearTimeout(timer);
        ws.close();
        resolve();
      });
      ws.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    })).resolves.toBeUndefined();
  });

  it('refuses a WebSocket without Origin from outside loopback unless it has a pairing token', async () => {
    expect(isLoopbackRemote('127.0.0.1')).toBe(true);
    expect(isLoopbackRemote('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackRemote('192.168.1.20')).toBe(false);
    const ip = lanAddress();
    if (!ip) return;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-csrf-lan-'));
    server = await createHarnessServer({
      gantryHome: path.join(root, 'home'),
      host: '0.0.0.0',
      port: 0,
    });
    const refused = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://${ip}:${server!.port}`);
      ws.on('open', () => {
        ws.close();
        reject(new Error('LAN websocket without Origin opened'));
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => undefined);
    });
    expect(refused).toBe(403);
    const code = server.store.generatePairingCode();
    const token = server.store.verifyPairingCode(code);
    expect(token).toBeTruthy();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://${ip}:${server!.port}/?token=${encodeURIComponent(token!)}`);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('paired LAN websocket did not open'));
      }, 2000);
      ws.on('open', () => {
        clearTimeout(timer);
        ws.close();
        resolve();
      });
      ws.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  });
});
