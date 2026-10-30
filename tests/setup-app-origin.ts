/**
 * Node's fetch does not send Origin. State-changing routes now require the app
 * origin, which is what the browser sets and what the CLI sends. This wrapper
 * opts the existing suite in the same way. Security tests import `nativeFetch`
 * so they can omit or forge Origin.
 *
 * jsdom's WebSocket advertises the document origin (typically localhost:3000),
 * which is not the harness server under test. The real window is served by
 * that server, so the browser's Origin matches. The Node client omits Origin;
 * the server allows a missing WebSocket Origin because browsers cannot omit it.
 */
import { beforeAll } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';

beforeAll(() => {
  if (typeof window === 'undefined') return;
  class HarnessTestWebSocket {
    private inner: InstanceType<typeof NodeWebSocket> | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onopen: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    readyState = 0;

    constructor(url: string | URL, protocols?: string | string[]) {
      const target = String(url);
      let hostname = '';
      try {
        hostname = new URL(target).hostname;
      } catch {
        hostname = '';
      }
      // jsdom's page origin is not the harness. Only the API host should open a socket.
      if (hostname !== '127.0.0.1' && hostname !== '::1') return;
      const socket = protocols === undefined ? new NodeWebSocket(target) : new NodeWebSocket(target, protocols);
      this.inner = socket;
      socket.on('message', (data) => this.onmessage?.({ data }));
      socket.on('open', () => {
        this.readyState = socket.readyState;
        this.onopen?.({});
      });
      socket.on('close', () => {
        this.readyState = socket.readyState;
        this.onclose?.({});
      });
      socket.on('error', () => this.onerror?.({}));
    }

    close(): void {
      const socket = this.inner;
      if (!socket) return;
      if (socket.readyState === NodeWebSocket.CONNECTING) socket.terminate();
      else socket.close();
    }
  }

  window.WebSocket = HarnessTestWebSocket as unknown as typeof WebSocket;
  globalThis.WebSocket = window.WebSocket;
});

const native = globalThis.fetch.bind(globalThis);

export const nativeFetch: typeof fetch = native;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const method = (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (!MUTATING.has(method)) return native(input, init);
  let url: URL;
  try {
    url = new URL(requestUrl(input));
  } catch {
    return native(input, init);
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1') {
    return native(input, init);
  }
  const headers = new Headers(init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
  if (!headers.has('Origin')) headers.set('Origin', url.origin);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return native(input, { ...init, headers });
}) as typeof fetch;
