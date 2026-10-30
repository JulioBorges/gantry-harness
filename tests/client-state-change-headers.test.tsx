// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket as NodeWebSocket } from 'ws';
import { App } from '../src/client/App.js';
import { createHarnessServer, type HarnessServerInstance } from '../src/server/app.js';
import { nativeFetch } from './setup-app-origin.js';

function lanAddress(): string | undefined {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

let server: HarnessServerInstance | undefined;
let root: string | undefined;
let previousFetch: typeof fetch | undefined;

afterEach(async () => {
  cleanup();
  localStorage.clear();
  if (previousFetch) globalThis.fetch = previousFetch;
  if (server) await server.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

it('the settings UI sends JSON when generating a pairing code', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-csrf-ui-'));
  const started = await createHarnessServer({ gantryHome: path.join(root, 'home'), port: 0 });
  server = started;
  const calls: Array<{ method: string; url: string; contentType: string | null; origin: string | null }> = [];
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url: String(input), contentType: headers.get('content-type'), origin: headers.get('origin') });
    // The page under test is jsdom, not the harness origin. The browser would set
    // Origin itself; this forwarder supplies that same-origin value after recording
    // the headers the UI actually passed.
    if (method !== 'GET' && method !== 'HEAD' && !headers.has('Origin')) {
      headers.set('Origin', `http://127.0.0.1:${started.port}`);
    }
    return nativeFetch(input, { ...init, headers });
  }) as typeof fetch;

  render(<App apiBaseUrl={`http://127.0.0.1:${started.port}`} />);
  fireEvent.click(await screen.findByTestId('open-settings-btn'));
  fireEvent.click(screen.getByRole('tab', { name: 'Acesso remoto' }));
  fireEvent.click(screen.getByRole('button', { name: 'Gerar código de acesso' }));
  const display = await screen.findByTestId('pairing-code-display');
  expect(display.textContent).toMatch(/Código: \d{6}/);
  const post = calls.find((call) => call.method === 'POST' && call.url.includes('/api/auth/pair/generate'));
  expect(post).toEqual({
    method: 'POST',
    url: `http://127.0.0.1:${started.port}/api/auth/pair/generate`,
    contentType: 'application/json',
    origin: null,
  });
});

const lanIp = lanAddress();

it.skipIf(!lanIp)('clears a stale token and returns to pairing when the remote socket is refused', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-csrf-ui-token-'));
  const started = await createHarnessServer({
    gantryHome: path.join(root, 'home'),
    host: '0.0.0.0',
    port: 0,
    requirePairingForRemote: true,
  });
  server = started;
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  localStorage.setItem('gantry_auth_token', 'gantry_auth_token-stale');
  try {
    render(<App apiBaseUrl={`http://${lanIp}:${started.port}`} />);
    expect(await screen.findByTestId('remote-pairing-screen')).toBeTruthy();
    expect(localStorage.getItem('gantry_auth_token')).toBeNull();
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }
});
