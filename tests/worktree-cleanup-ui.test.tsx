// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../src/client/App.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const backup = 'a'.repeat(40);

function mockCleanupWorkspace() {
  vi.stubGlobal('queryLocalFonts', vi.fn(async () => []));
  const state = {
    projects: [{ id: 'project', name: 'My project', path: '/tmp/project', badgeState: 'idle' }],
    layout: { activeProjectId: 'project', activeSessionId: 'session' },
    sessions: [{ id: 'session', title: 'Main' }],
    messages: [],
    terminalSettings: { fontFamily: 'monospace', fontSize: 15, shell: 'system' },
    terminalEnvironment: { platform: 'linux', platformLabel: 'Linux', shells: [{ id: 'system', label: 'Padrão do sistema', available: true }] },
    settings: { mode: 'cli', activeProvider: 'cli', cliHarness: 'claude', providers: { cli: { model: 'saved-model' } } },
    connection: { mode: 'cli', host: 'codex', model: null, source: 'repository', ready: true, detail: 'CLI encontrado.' },
  };
  const inspection = {
    specs: [],
    issues: [],
    worktrees: [],
    remediationCards: [{ kind: 'dirty_worktree', title: 'Worktree suja', description: 'Há alterações.', remediation: 'Limpe ou faça commit.' }],
    policy: { execution: { hostHarness: 'codex' } },
    operatorProfile: {},
    skillPack: { found: true },
    hasTrackedPolicy: true,
  };
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url);
    if (route.endsWith('/worktree/preview') && init?.method === 'POST') {
      return Response.json({ root: '/tmp/project', token: 'preview-token', files: [{ path: 'a', status: ' M' }, { path: 'locked/t', status: ' M' }, { path: 'u1', status: '??' }], backups: [] });
    }
    if (route.endsWith('/worktree/clean') && init?.method === 'POST') {
      return Response.json({
        backup,
        clean: false,
        verified: false,
        keep: ['locked/t'],
        reverted: ['a'],
        restore: `git restore --source '${backup}^3' --worktree -- 'u1'`,
        restoreTracked: `git restore --source '${backup}' --worktree -- 'a'`,
        conflicts: ['later.txt'],
      });
    }
    if (route.endsWith('/workspace/state')) return Response.json(state);
    if (route.endsWith('/inspect')) return Response.json(inspection);
    if (route.endsWith('/board')) return Response.json({ runs: [] });
    if (route.endsWith('/panes')) return Response.json({ panes: [] });
    if (route.includes('/discovery')) return Response.json({ harness: 'codex', models: [] });
    if (route.endsWith('/alerts')) return Response.json({ alerts: [] });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

it('shows the partial cleanup recovery inside the open project dialog', async () => {
  mockCleanupWorkspace();
  render(<App />);
  await screen.findAllByText('My project');
  fireEvent.click(screen.getByTestId('project-settings-project'));
  const dialog = await screen.findByRole('dialog', { name: 'Configurações de My project' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Limpar worktree' }));
  await within(dialog).findByRole('heading', { name: 'Limpar worktree de My project?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar backup e limpar worktree' }));
  await waitFor(() => expect(within(dialog).getByText(/Não os apague/)).toBeTruthy());
  expect(within(dialog).getByText('locked/t')).toBeTruthy();
  expect(within(dialog).getByText(`git restore --source '${backup}^3' --worktree -- 'u1'`)).toBeTruthy();
  expect(within(dialog).getByText(`git restore --source '${backup}' --worktree -- 'a'`)).toBeTruthy();
  expect(within(dialog).getByText(/devolveu ao HEAD/)).toBeTruthy();
  expect(within(dialog).getByText('later.txt')).toBeTruthy();
  expect(within(dialog).getByText(/não os substituiu/)).toBeTruthy();
  const warning = within(dialog).getByText(/não use este comando/);
  expect(warning.textContent).toContain(`git stash apply --index ${backup}`);
  expect(warning.textContent).toContain('o Git recusa a operação');
  expect(dialog.isConnected).toBe(true);
});

it('hides a recovery command that contains the checkout path', async () => {
  const fetchMock = mockCleanupWorkspace();
  const fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/worktree/clean') && init?.method === 'POST') {
      return Response.json({
        backup,
        clean: false,
        verified: false,
        keep: ['locked/t'],
        restoreTracked: `git restore --source '${backup}' --worktree -- '/tmp/project/a'`,
      });
    }
    return fallback(url, init);
  });
  render(<App />);
  await screen.findAllByText('My project');
  fireEvent.click(screen.getByTestId('project-settings-project'));
  const dialog = await screen.findByRole('dialog', { name: 'Configurações de My project' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Limpar worktree' }));
  await within(dialog).findByRole('heading', { name: 'Limpar worktree de My project?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar backup e limpar worktree' }));
  await waitFor(() => expect(within(dialog).getByText(/Não os apague/)).toBeTruthy());
  expect(within(dialog).queryByText(/\/tmp\/project\/a/)).toBeNull();
});
