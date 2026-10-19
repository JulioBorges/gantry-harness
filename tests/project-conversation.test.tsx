// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/client/App.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('replaces the visible conversation when the operator selects another project', async () => {
  vi.stubGlobal('queryLocalFonts', vi.fn(async () => []));
  let selected = 'alpha';
  const conversations: Record<string, { session: string; text: string }> = {
    alpha: { session: 'sess-alpha', text: 'conversa exclusiva do Alpha' },
    beta: { session: 'sess-beta', text: 'conversa exclusiva do Beta' },
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url);
    if (route.endsWith('/workspace/state') && init?.method === 'PUT') {
      selected = JSON.parse(String(init.body)).activeProjectId;
      return Response.json({ layout: { activeProjectId: selected, activeSessionId: conversations[selected].session } });
    }
    if (route.endsWith('/workspace/state')) {
      const conversation = conversations[selected];
      return Response.json({
        projects: [
          { id: 'alpha', name: 'Alpha', path: '/tmp/alpha', badgeState: 'idle' },
          { id: 'beta', name: 'Beta', path: '/tmp/beta', badgeState: 'idle' },
        ],
        layout: { activeProjectId: selected, activeSessionId: conversation.session },
        sessions: [{ id: conversation.session, projectId: selected, title: 'Main Workspace Session' }],
        messages: [{ id: `msg-${selected}`, projectId: selected, sessionId: conversation.session, role: 'user', content: conversation.text, createdAt: '2026-10-19T00:00:00.000Z' }],
        terminalSettings: { fontFamily: 'monospace', fontSize: 15, shell: 'system' },
        terminalEnvironment: { platform: 'linux', platformLabel: 'Linux', shells: [{ id: 'system', label: 'Padrão do sistema', available: true }] },
        settings: { mode: 'cli', activeProvider: 'cli', cliHarness: 'codex', providers: { cli: { model: '' } } },
        connection: { mode: 'cli', host: 'codex', model: null, source: 'repository', ready: true, detail: 'CLI encontrado.' },
      });
    }
    if (route.endsWith('/alerts')) return Response.json({ alerts: [] });
    if (route.endsWith('/kanban')) return Response.json({ runs: [] });
    if (route.endsWith('/panes')) return Response.json({ panes: [] });
    if (route.endsWith('/inspect')) return Response.json({ specs: [], issues: [], worktrees: [], remediationCards: [], policy: { execution: { hostHarness: 'codex', roles: {} } }, operatorProfile: {}, skillPack: { found: false }, hasTrackedPolicy: false });
    if (route.endsWith('/board')) return Response.json({ resolution: 'none', executionEnabled: false, explanation: null, issues: [], specs: [], frontier: [] });
    return Response.json({});
  }));

  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Conversa' }));
  expect(await screen.findByText('conversa exclusiva do Alpha')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Conversa' }));
  expect(await screen.findByText('conversa exclusiva do Beta')).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('conversa exclusiva do Alpha')).toBeNull());
});
