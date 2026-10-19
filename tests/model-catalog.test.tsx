// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../src/client/App.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const catalogs: Record<string, Array<{ id: string; name?: string }>> = {
  codex: [{ id: 'gpt-5.2-codex', name: 'GPT 5.2 Codex' }],
  'claude-code': [{ id: 'claude-sonnet-4-6' }, { id: 'claude-opus-4-5' }],
  opencode: [{ id: 'openai/gpt-5.2-codex' }, { id: 'anthropic/claude-opus-4-5' }],
  antigravity: [{ id: 'gemini-2.5-pro' }],
};

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
    if (route.includes('/discovery')) {
      const harness = new URL(route, 'http://127.0.0.1').searchParams.get('harness') ?? '';
      return Response.json({ harness, models: catalogs[harness] ?? [] });
    }
    if (route.endsWith('/alerts')) return Response.json({ alerts: [] });
    if (route.endsWith('/kanban')) return Response.json({ runs: [] });
    if (route.endsWith('/board')) return Response.json({ resolution: 'none', executionEnabled: false, explanation: null, issues: [], specs: [], frontier: [] });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

it('offers only the selected role host models and drops a model from another host', async () => {
  mockWorkspace();
  render(<App />);
  await screen.findAllByText('My project');
  fireEvent.click(screen.getByTestId('open-settings-btn'));
  fireEvent.click(screen.getByRole('tab', { name: 'Projeto' }));
  const model = await screen.findByLabelText('Modelo para implement');
  await waitFor(() => expect(within(model).getByRole('option', { name: /gpt-5.2-codex/ })).toBeTruthy());
  expect(within(model).queryByRole('option', { name: 'claude-sonnet-4-6' })).toBeNull();
  expect(within(model).queryByRole('option', { name: 'anthropic/claude-opus-4-5' })).toBeNull();
  expect(within(model).getByRole('option', { name: /incompatível com Codex/ })).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Host para implement'), { target: { value: 'claude-code' } });
  const nextModel = screen.getByLabelText('Modelo para implement');
  await waitFor(() => expect(within(nextModel).getByRole('option', { name: 'claude-sonnet-4-6' })).toBeTruthy());
  expect(within(nextModel).queryByRole('option', { name: /gpt-5.2-codex/ })).toBeNull();
  expect(within(nextModel).queryByRole('option', { name: /incompatível/ })).toBeNull();
  expect((nextModel as HTMLSelectElement).value).toBe('');
  fireEvent.change(nextModel, { target: { value: 'claude-opus-4-5' } });
  expect((screen.getByLabelText('Modelo para implement') as HTMLSelectElement).value).toBe('claude-opus-4-5');
});

it('lists coordinator models from the selected CLI host', async () => {
  mockWorkspace();
  render(<App />);
  await screen.findAllByText('My project');
  fireEvent.click(screen.getByTestId('open-settings-btn'));
  fireEvent.click(screen.getByRole('tab', { name: 'Conexão de IA' }));
  const model = await screen.findByLabelText('Modelo do coordenador');
  await waitFor(() => expect(within(model).getByRole('option', { name: 'claude-sonnet-4-6' })).toBeTruthy());
  expect(within(model).queryByRole('option', { name: /gpt-5.2-codex/ })).toBeNull();
  fireEvent.change(screen.getByLabelText('Host para projetos sem configuração'), { target: { value: 'codex' } });
  const codexModel = screen.getByLabelText('Modelo do coordenador');
  await waitFor(() => expect(within(codexModel).getByRole('option', { name: /gpt-5.2-codex/ })).toBeTruthy());
  expect(within(codexModel).queryByRole('option', { name: 'claude-sonnet-4-6' })).toBeNull();
  expect((codexModel as HTMLSelectElement).value).toBe('');
});
