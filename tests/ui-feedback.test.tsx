// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../src/client/App.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mockWorkspace(chat?: () => Promise<Response>, options?: { platform?: string }) {
  vi.stubGlobal('queryLocalFonts', vi.fn(async () => [{ family: 'Fira Code' }, { family: 'Menlo' }]));
  const state = {
    projects: [{ id: 'project', name: 'My project', path: '/tmp/project', badgeState: 'idle' }],
    layout: { activeProjectId: 'project', activeSessionId: 'session' },
    sessions: [{ id: 'session', title: 'Main' }], messages: [],
    terminalSettings: { fontFamily: 'monospace', fontSize: 15, shell: 'system' },
    terminalEnvironment: { platform: options?.platform ?? 'linux', platformLabel: options?.platform === 'win32' ? 'Windows' : 'Linux', shells: [{ id: 'system', label: 'Padrão do sistema', available: true }, { id: 'bash', label: 'Bash', available: true }, { id: 'sh', label: 'Sh', available: false }] },
    settings: { mode: 'cli', activeProvider: 'cli', cliHarness: 'claude', providers: { cli: { model: 'saved-model' } } },
    connection: { mode: 'cli', host: 'codex', model: null, source: 'repository', ready: true, detail: 'CLI encontrado.' },
  };
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url);
    if (route.endsWith('/chat') && chat) return chat();
    if (route.endsWith('/api/projects') && init?.method === 'POST') return Response.json({ error: 'Directory does not exist: /missing' }, { status: 400 });
    if (route.endsWith('/workspace/state')) return Response.json(state);
    if (route.endsWith('/inspect')) return Response.json({ specs: [], issues: [], worktrees: [], remediationCards: [], policy: { execution: { hostHarness: 'codex' } }, operatorProfile: {}, skillPack: { found: true }, hasTrackedPolicy: true });
    if (route.includes('/discovery')) {
      const harness = new URL(route, 'http://127.0.0.1').searchParams.get('harness');
      const catalogs: Record<string, Array<{ id: string }>> = {
        'claude-code': [{ id: 'saved-model' }, { id: 'claude-sonnet-4-6' }],
        codex: [{ id: 'gpt-5.2-codex' }],
        opencode: [{ id: 'openai/gpt-5.2-codex' }],
        antigravity: [{ id: 'gemini-2.5-pro' }],
      };
      return Response.json({ harness, models: catalogs[harness ?? ''] ?? [] });
    }
    if (route.endsWith('/alerts')) return Response.json({ alerts: [] });
    if (route.endsWith('/kanban')) return Response.json({ runs: [] });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

it('shows a project-registration error instead of silently ignoring the button', async () => {
  mockWorkspace();
  render(<App />);
  await screen.findAllByText('My project');
  fireEvent.click(screen.getByTestId('new-project-btn'));
  fireEvent.change(screen.getByPlaceholderText('/path/to/repo'), { target: { value: '/missing' } });
  fireEvent.click(screen.getByTestId('add-project-btn'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Directory does not exist'));
  expect((screen.getByPlaceholderText('/path/to/repo') as HTMLInputElement).value).toBe('/missing');
});

it('opens settings without a coordinator connection', async () => {
  mockWorkspace();
  render(<App />);
  await screen.findAllByText('My project');
  expect(screen.queryByText(/Agent Host/)).toBeNull();
  fireEvent.click(screen.getByTestId('open-settings-btn'));
  expect(screen.queryByRole('tab', { name: 'Conexão de IA' })).toBeNull();
  expect(screen.getByRole('tab', { name: 'Gantry' })).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'Projeto' })).toBeNull();
});

it('returns to a CLI terminal in one click without toggling the coordinator into a different backend mode', async () => {
  const fetchMock = mockWorkspace();
  const fallback = fetchMock.getMockImplementation()!;
  const pane = { paneId: 'existing', launcher: 'shell', status: 'running', terminalBuffer: 'saved output', mode: 'terminal' };
  fetchMock.mockImplementation(async (url, init) => String(url).includes('/panes') ? Response.json({ panes: [pane], pane }) : fallback(url, init));
  render(<App />);
  await screen.findAllByText('My project');
  fireEvent.click(screen.getByTestId('chat-terminal-toggle'));
  await screen.findByTestId('terminal-view');
  expect(screen.queryByRole('button', { name: /^Conversa$/ })).toBeNull();
  expect(screen.queryByTestId('chat-view')).toBeNull();
  expect(screen.queryByLabelText('Nova conversa')).toBeNull();
  fireEvent.click(screen.getByTestId('chat-terminal-toggle'));
  await screen.findByTestId('terminal-view');
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/toggle'))).toBe(false);
  expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/panes') && init?.method === 'POST')).toBe(false);
});


it('opens a system shell from the new tab control and not from the Terminal selector', async () => {
  const fetchMock = mockWorkspace();
  const fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => String(url).endsWith('/panes') && init?.method === 'POST'
    ? Response.json({ pane: { paneId: 'new-shell', launcher: 'shell', terminalBuffer: 'prompt', status: 'running' } })
    : fallback(url, init));
  render(<App />);
  await screen.findAllByText('My project');
  fireEvent.click(screen.getByTestId('chat-terminal-toggle'));
  fireEvent.click(screen.getByTestId('open-factory-btn'));
  await screen.findByTestId('terminal-view');
  expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/panes') && init?.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByTestId('open-settings-btn'));
  expect(within(screen.getByRole('dialog', { name: 'Configurações' })).queryByText(/Alternar conversa e terminal/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Fechar configurações' }));
  fireEvent.click(screen.getByTestId('launcher-shell'));
  await waitFor(() => {
    const creation = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/panes') && init?.method === 'POST');
    expect(JSON.parse(creation![1]!.body as string)).toMatchObject({ launcher: 'shell', mode: 'terminal' });
  });
  expect(screen.queryByTestId('launcher-codex')).toBeNull();
});

it('puts all settings in one modal, loads server OS options, saves terminal preferences, and preserves the workspace', async () => {
  const fetchMock = mockWorkspace();
  const fallback = fetchMock.getMockImplementation()!;
  const environment = { platform: 'linux', platformLabel: 'Linux', shells: [{ id: 'system', label: 'Padrão do sistema', available: true }, { id: 'bash', label: 'Bash', available: true }, { id: 'sh', label: 'Sh', available: false }] };
  fetchMock.mockImplementation(async (url, init) => String(url).endsWith('/settings/terminal')
    ? Response.json({ settings: JSON.parse(init!.body as string), environment }) : fallback(url, init));
  render(<App />);
  await screen.findAllByText('My project');
  fireEvent.click(screen.getByTestId('open-factory-btn'));
  const open = screen.getByTestId('open-settings-btn');
  expect(screen.queryByTestId('open-setup-btn')).toBeNull();
  open.focus();
  fireEvent.click(open);
  const dialog = screen.getByRole('dialog', { name: 'Configurações' });
  expect(within(dialog).getAllByRole('tab')).toHaveLength(3);
  expect(within(dialog).queryByRole('tab', { name: 'Conexão de IA' })).toBeNull();
  expect((screen.getByLabelText('Tamanho da fonte (px)') as HTMLInputElement).value).toBe('15');
  expect(within(dialog).queryByRole('option', { name: /Zsh|PowerShell|CMD/ })).toBeNull();
  expect((within(dialog).getByRole('option', { name: 'Sh (indisponível)' }) as HTMLOptionElement).disabled).toBe(true);
  await screen.findByRole('option', { name: 'Fira Code' });
  expect(screen.getByLabelText('Fonte do terminal').tagName).toBe('SELECT');
  fireEvent.change(screen.getByLabelText('Fonte do terminal'), { target: { value: '"Fira Code", monospace' } });
  fireEvent.change(screen.getByLabelText('Tamanho da fonte (px)'), { target: { value: '18' } });
  fireEvent.change(screen.getByLabelText('Shell do terminal'), { target: { value: 'bash' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar terminal' }));
  await waitFor(() => expect(within(dialog).getByRole('status').textContent).toContain('Salvar terminal: resposta recebida.'));
  const creation = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/settings/terminal'));
  expect(JSON.parse(creation![1]!.body as string)).toEqual({ fontFamily: '"Fira Code", monospace', fontSize: 18, shell: 'bash' });
  fireEvent.keyDown(within(dialog).getByRole('tab', { name: 'Terminal' }), { key: 'End' });
  expect(screen.getByRole('tab', { name: 'Acesso remoto' }).getAttribute('aria-selected')).toBe('true');
  expect(within(dialog).getByRole('button', { name: 'Gerar código de acesso' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Configurações de My project' }));
  expect(screen.getByTestId('setup-panel')).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'Projeto' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Fechar configurações do projeto' }));
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(open);
  expect(screen.queryByTestId('chat-view')).toBeNull();
  expect(screen.getByTestId('terminal-view')).toBeTruthy();
  expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/panes') && init?.method === 'DELETE')).toBe(false);
});

it('keeps terminal settings errors and the unsaved draft inside the modal', async () => {
  const fetchMock = mockWorkspace();
  const fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => String(url).endsWith('/settings/terminal')
    ? Response.json({ error: 'Shell não encontrado' }, { status: 400 }) : fallback(url, init));
  render(<App />);
  await screen.findAllByText('My project');
  fireEvent.click(screen.getByTestId('open-settings-btn'));
  fireEvent.change(screen.getByLabelText('Tamanho da fonte (px)'), { target: { value: '18' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar terminal' }));
  const dialog = screen.getByRole('dialog', { name: 'Configurações' });
  await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('Shell não encontrado'));
  expect((screen.getByLabelText('Tamanho da fonte (px)') as HTMLInputElement).value).toBe('18');
});

it('shows a bootstrap error inside the open project settings dialog', async () => {
  const fetchMock = mockWorkspace();
  const fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => String(url).endsWith('/bootstrap') && init?.method === 'POST'
    ? Response.json({ error: 'Não foi possível registrar a instalação do Gantry: identidade ausente. Revise os arquivos e faça commit antes de executar o Gantry.', code: 'git-identity-unknown' }, { status: 409 })
    : fallback(url, init));
  render(<App />);
  await screen.findAllByText('My project');
  fireEvent.click(screen.getByTestId('project-settings-project'));
  const dialog = screen.getByRole('dialog', { name: 'Configurações de My project' });
  fireEvent.click(within(dialog).getByTestId('bootstrap-skills-btn'));
  const alert = await within(dialog).findByRole('alert');
  expect(alert.textContent).toContain('identidade ausente');
  expect(dialog.contains(alert)).toBe(true);
  expect(screen.getByRole('dialog', { name: 'Configurações de My project' })).toBeTruthy();
});

it('quotes recovery commands for cmd and PowerShell on Windows', async () => {
  const fetchMock = mockWorkspace(undefined, { platform: 'win32' });
  const fallback = fetchMock.getMockImplementation()!;
  const hash = 'abc123def456abc123def456abc123def456abc1';
  const restore = `git restore --source '${hash}^3' --worktree -- 'a b' 'it'\\''s' 'say "hi"' '100%' 'a^b' 'a&b' 'a\`b' '$home' '-lead'`;
  fetchMock.mockImplementation(async (url, init) => {
    const route = String(url);
    if (route.endsWith('/inspect')) return Response.json({ specs: [], issues: [], worktrees: [], remediationCards: [{ kind: 'dirty_worktree', title: 'Worktree suja', description: 'Há alterações.', remediation: 'Limpe.' }], policy: { execution: { hostHarness: 'codex' } }, operatorProfile: {}, skillPack: { found: true }, hasTrackedPolicy: true });
    if (route.endsWith('/worktree/preview') && init?.method === 'POST') return Response.json({ root: '/tmp/project', token: 't'.repeat(64), files: [{ path: 'a b', status: '??' }], backups: [{ hash, subject: 'gantry-harness-cleanup-old' }] });
    if (route.endsWith('/worktree/clean') && init?.method === 'POST') return Response.json({ backup: hash, clean: false, verified: false, keep: ['README.md'], restore });
    return fallback(url, init);
  });
  render(<App />);
  await screen.findAllByText('My project');
  fireEvent.click(screen.getByTestId('project-settings-project'));
  const dialog = screen.getByRole('dialog', { name: 'Configurações de My project' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Limpar worktree' }));
  const preview = await within(dialog).findByRole('region', { name: 'Revisar limpeza da worktree' });
  expect(within(preview).getByTestId('recovery-command-powershell').textContent).toContain(`'${hash}'`);
  expect(within(preview).getByTestId('recovery-command-cmd').textContent).toContain(hash);
  expect(within(preview).queryByText(`git stash apply --index ${hash}`)).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar backup e limpar worktree' }));
  await within(dialog).findByText(/não foi confirmado/i);
  const powershell = await within(dialog).findAllByTestId('recovery-command-powershell');
  const cmd = within(dialog).getAllByTestId('recovery-command-cmd');
  const shown = powershell.map(node => node.textContent).join('\n');
  const shownCmd = cmd.map(node => node.textContent).join('\n');
  expect(shown).toContain("'a b'");
  expect(shown).toContain("'it''s'");
  expect(shown).toContain(`'say "hi"'`);
  expect(shown).toContain("'100%'");
  expect(shown).toContain("'a^b'");
  expect(shown).toContain("'a&b'");
  expect(shown).toContain("'a`b'");
  expect(shown).toContain("'$home'");
  expect(shown).toContain("'-lead'");
  expect(shownCmd).toContain('"a b"');
  expect(shownCmd).toContain('"-lead"');
  expect(shownCmd).toContain('"a^b"');
  expect(shownCmd).toContain('"a&b"');
  expect(shownCmd).not.toContain("git restore --source '");
});
