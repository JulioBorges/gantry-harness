import { describe, expect, it } from 'vitest';
import { evaluateStateChangeGuard, isAppHost, isAppOrigin } from '../src/server/stateChangeGuard.js';

const local = { bindHost: '127.0.0.1', port: 7400 };

describe('state-change guard', () => {
  it('accepts the loopback origins this server serves', () => {
    for (const origin of ['http://127.0.0.1:7400', 'http://localhost:7400', 'http://[::1]:7400']) {
      expect(evaluateStateChangeGuard({ origin, contentType: 'application/json' }, local)).toBeNull();
      expect(evaluateStateChangeGuard({ origin, contentType: 'application/json; charset=utf-8' }, local)).toBeNull();
    }
  });

  it('refuses a missing, null, foreign, https or wrong-port origin before looking at content type', () => {
    const cases = [undefined, 'null', 'https://evil.example', 'http://evil.example:7400', 'https://127.0.0.1:7400', 'http://127.0.0.1:7399', 'http://127.0.0.1:7400/app', 'http://user:pass@127.0.0.1:7400'];
    for (const origin of cases) {
      expect(evaluateStateChangeGuard({ origin, contentType: 'text/plain' }, local)).toEqual({ statusCode: 403, error: 'Origem recusada.' });
      expect(evaluateStateChangeGuard({ origin, contentType: 'application/json' }, local)).toEqual({ statusCode: 403, error: 'Origem recusada.' });
    }
    expect(isAppOrigin(undefined, '127.0.0.1:7400', local)).toBe(false);
  });

  it('requires application/json once the origin belongs to the app', () => {
    const origin = 'http://127.0.0.1:7400';
    for (const contentType of [undefined, '', 'text/plain', 'text/plain;charset=utf-8', 'application/json, text/plain', 'application/json; charset']) {
      expect(evaluateStateChangeGuard({ origin, contentType }, local)).toEqual({ statusCode: 415, error: 'Content-Type deve ser application/json.' });
    }
  });

  it('accepts only an app Host, including the listening port', () => {
    expect(isAppHost('127.0.0.1:7400', local)).toBe(true);
    expect(isAppHost('localhost:7400', local)).toBe(true);
    expect(isAppHost('[::1]:7400', local)).toBe(true);
    expect(isAppHost('evil.example', local)).toBe(false);
    expect(isAppHost('evil.example:7400', local)).toBe(false);
    expect(isAppHost('127.0.0.1:7399', local)).toBe(false);
    expect(isAppHost(undefined, local)).toBe(false);
    expect(isAppHost('192.168.1.20:7400', { bindHost: '192.168.1.20', port: 7400 })).toBe(true);
    expect(isAppHost('10.0.0.8:7400', { bindHost: '0.0.0.0', port: 7400 })).toBe(true);
    expect(isAppHost('evil.example:7400', { bindHost: '0.0.0.0', port: 7400 })).toBe(false);
    expect(isAppHost('127.0.0.1', { bindHost: '127.0.0.1', port: 80 })).toBe(true);
    expect(isAppHost('localhost', { bindHost: '127.0.0.1', port: 80 })).toBe(true);
    expect(isAppHost('[::1]', { bindHost: '::', port: 443 })).toBe(true);
    expect(isAppHost('127.0.0.1', { bindHost: '127.0.0.1', port: 7400 })).toBe(false);
    expect(isAppHost('127.0.0.1:80', { bindHost: '127.0.0.1', port: 7400 })).toBe(false);
  });

  it('rejects a Host whose port is not a decimal integer in range', () => {
    const port = 7400;
    for (const host of [`127.0.0.1:${port}.0`, '127.0.0.1:abc', '127.0.0.1:65536', '127.0.0.1:', '[::1', `[::1]:${port}x`, '::1', '', '   ']) {
      expect(isAppHost(host, local), host).toBe(false);
    }
    expect(isAppHost(`[::1]:${port}`, local)).toBe(true);
  });

  it('accepts a concrete bind host and a wildcard bind reached by an IP literal', () => {
    expect(isAppOrigin('http://192.168.1.20:7400', undefined, { bindHost: '192.168.1.20', port: 7400 })).toBe(true);
    expect(isAppOrigin('http://192.168.1.20:7400', '192.168.1.20:7400', { bindHost: '0.0.0.0', port: 7400 })).toBe(true);
    expect(isAppOrigin('http://evil.example:7400', 'evil.example:7400', { bindHost: '0.0.0.0', port: 7400 })).toBe(false);
    expect(isAppOrigin('http://10.0.0.8:7400', '10.0.0.9:7400', { bindHost: '0.0.0.0', port: 7400 })).toBe(false);
    expect(isAppOrigin('http://0.0.0.0:7400', '0.0.0.0:7400', { bindHost: '0.0.0.0', port: 7400 })).toBe(true);
  });
});
