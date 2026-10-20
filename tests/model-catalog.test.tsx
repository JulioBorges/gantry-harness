// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from '../src/client/App.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mockWorkspace() {
  vi.stubGlobal('queryLocalFonts', vi.fn(async () => []));
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const route = String(url);
    if (route.endsWith('/workspace/state')) {
      return Response.json({
        projects: [{ id: 'project', name: 'My project', path: '/tmp/project', badgeState: 'idle' }],
        layout: { activeProjectId: 'project', activeSessionId: 'session' },
        sessions: [{ id: 'session', title: 'Main' }],
        messages: [],
        terminalSettings: { fontFamily: 'monospace', fontSize: 15, shell: 'system' },
        terminalEnvironment: { platform: 'linux', platformLabel: 'Linux', shells: [{ id: 'system', label: 'Padrão do sistema', available: true }] },
        settings: { mode: 'cli', activeProvider: 'cli', cliHarness: 'claude', providers: { cli: { model: 'claude-sonnet-4-6' } } },
        connection: { mode: 'cli', host: 'codex', model: null, source: 'repository', ready: true, detail: 'CLI encontrado.' },
      });
    }
    if (route.endsWith('/inspect')) {
      return Response.json({
        specs: [], issues: [], worktrees: [], remediationCards: [],
        policy: { execution: { hostHarness: 'codex', roles: { implement: { harness: 'codex', model: 'anthropic/claude-opus-4-5' } } } },
        operatorProfile: {}, skillPack: { found: true }, hasTrackedPolicy: true,
      });
    }
    if (route.endsWith('/alerts')) return Response.json({ alerts: [] });
    if (route.endsWith('/kanban')) return Response.json({ runs: [] });
    if (route.endsWith('/board')) return Response.json({ resolution: 'none', executionEnabled: false, explanation: null, issues: [], specs: [], frontier: [] });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

it('shows command fields instead of host and model selectors, including with legacy policy', async () => {
  mockWorkspace();
  render(<App />);
  await screen.findAllByText('My project');
  fireEvent.click(screen.getByRole('button', { name: 'Configurações de My project' }));
  await screen.findByLabelText('Comando para implement');
  expect(screen.queryByLabelText('Modelo para implement')).toBeNull();
  expect(screen.queryByLabelText('Host para implement')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Fechar configurações do projeto' }));
  fireEvent.click(screen.getByTestId('open-settings-btn'));
  fireEvent.click(screen.getByRole('tab', { name: 'Gantry' }));
  expect(screen.getByLabelText('Comando global para implement')).toBeTruthy();
  expect(screen.queryByLabelText('Host global')).toBeNull();
});

it('does not offer a coordinator connection tab', async () => {
  mockWorkspace();
  render(<App />);
  await screen.findAllByText('My project');
  fireEvent.click(screen.getByTestId('open-settings-btn'));
  expect(screen.queryByRole('tab', { name: 'Conexão de IA' })).toBeNull();
  expect(screen.queryByLabelText('Modelo do coordenador')).toBeNull();
  expect(screen.queryByText(/Agent Host/)).toBeNull();
});
