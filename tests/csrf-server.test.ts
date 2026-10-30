import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createHarnessServer, type HarnessServerInstance } from '../src/server/app.js';
import { STATE_CHANGING_METHOD_CHECKS, STATE_CHANGING_ROUTES } from '../src/server/stateChangingRoutes.js';
import { nativeFetch } from './setup-app-origin.js';

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
});
