// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/client/App.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mockWorkspace(options?: { projects?: boolean }) {
  vi.stubGlobal('queryLocalFonts', vi.fn(async () => []));
  const hasProject = options?.projects !== false;
  const state = {
    projects: hasProject ? [{ id: 'project', name: 'woba-darkforge', path: '/tmp/woba-darkforge', badgeState: 'idle' }] : [],
    layout: { activeProjectId: hasProject ? 'project' : null, activeSessionId: hasProject ? 'session' : null },
    sessions: hasProject ? [{ id: 'session', title: 'Main' }] : [],
    messages: [],
    terminalSettings: { fontFamily: 'monospace', fontSize: 15, shell: 'system' },
    terminalEnvironment: { platform: 'linux', platformLabel: 'Linux', shells: [{ id: 'system', label: 'Padrão do sistema', available: true }] },
    settings: { mode: 'cli', activeProvider: 'cli', cliHarness: 'claude', providers: {} },
    connection: { mode: 'cli', host: 'codex', model: null, source: 'repository', ready: true, detail: 'CLI encontrado.' },
  };
  const trees: Record<string, Array<{ name: string; path: string; kind: string }>> = {
    '': [
      { name: 'src', path: 'src', kind: 'directory' },
      { name: '.gitignore', path: '.gitignore', kind: 'file' },
      { name: 'README.md', path: 'README.md', kind: 'file' },
    ],
    src: [{ name: 'app.ts', path: 'src/app.ts', kind: 'file' }],
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const route = String(url);
    const parsed = new URL(route, 'http://gantry.local');
    if (route.endsWith('/workspace/state')) return Response.json(state);
    if (route.endsWith('/alerts')) return Response.json({ alerts: [] });
    if (route.endsWith('/inspect')) return Response.json({ specs: [], issues: [], worktrees: [{ path: '/tmp/woba-darkforge-wt', branch: 'gantry/files-01', badgeState: 'idle', issueRef: 'files#01' }], remediationCards: [], policy: { execution: { hostHarness: 'codex' } }, operatorProfile: {}, skillPack: { found: true }, hasTrackedPolicy: true, trackedFiles: ['README.md', 'src/app.ts'] });
    if (route.endsWith('/kanban')) return Response.json({ runs: [] });
    if (route.endsWith('/panes')) return Response.json({ panes: [] });
    if (parsed.pathname.endsWith('/tree')) {
      const query = parsed.searchParams.get('query') ?? '';
      if (query) return Response.json({ path: '', entries: query.toLowerCase() === 'readme' ? [{ name: 'README.md', path: 'docs/README.md', kind: 'file' }] : [] });
      return Response.json({ path: parsed.searchParams.get('path') ?? '', entries: trees[parsed.searchParams.get('path') ?? ''] ?? [] });
    }
    if (parsed.pathname.endsWith('/artifacts')) return Response.json({ path: parsed.searchParams.get('path'), content: 'export const app = true;\n', diff: '' });
    return Response.json({});
  }));
}

it('shows an empty Files tab until a project is open', async () => {
  mockWorkspace({ projects: false });
  render(<App />);
  fireEvent.click(screen.getByTestId('open-files-btn'));
  expect(screen.getByText('Abra uma pasta para ver os arquivos do projeto.')).toBeTruthy();
  expect(screen.queryByTestId('file-tree-root')).toBeNull();
});

it('expands the project tree and opens a file beside the listing', async () => {
  mockWorkspace();
  render(<App />);
  await screen.findAllByText('woba-darkforge');
  expect(screen.queryByText('Arquivos e worktrees')).toBeNull();
  expect(await screen.findByText('Worktrees')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Assumir' })).toBeTruthy();
  fireEvent.click(screen.getByTestId('open-files-btn'));
  const workspace = screen.getByTestId('files-workspace');
  expect(workspace.className).toContain('split');
  expect(screen.queryByTestId('chat-view')).toBeNull();
  expect(screen.getByTestId('file-viewer-placeholder').textContent).toContain('Selecione um arquivo');
  expect(screen.queryByRole('dialog', { name: 'Visualizar arquivo' })).toBeNull();
  const root = await screen.findByTestId('file-tree-root');
  expect(root.getAttribute('aria-expanded')).toBe('true');
  const folder = await screen.findByTestId('file-tree-src');
  expect(folder.compareDocumentPosition(screen.getByTestId('file-tree-README.md')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(folder);
  expect(await screen.findByTestId('file-tree-src/app.ts')).toBeTruthy();
  fireEvent.click(screen.getByTestId('file-tree-src/app.ts'));
  expect(await screen.findByTestId('file-viewer-pane')).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'Visualizar arquivo' })).toBeNull();
  expect(screen.getByTestId('file-tree-src/app.ts').className).toContain('selected');
  expect((screen.getByTestId('artifact-editor') as HTMLTextAreaElement).value).toContain('export const app = true;');
  fireEvent.change(screen.getByTestId('file-tree-filter'), { target: { value: 'readme' } });
  expect(await screen.findByTestId('file-tree-docs/README.md')).toBeTruthy();
  expect(screen.queryByTestId('file-tree-src/app.ts')).toBeNull();
});

it('opens a file in a modal and keeps the listing full width on a narrow screen', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  mockWorkspace();
  try {
    render(<App />);
    await screen.findAllByText('woba-darkforge');
    fireEvent.click(screen.getByTestId('open-files-btn'));
    const workspace = screen.getByTestId('files-workspace');
    expect(workspace.className).not.toContain('split');
    expect(screen.queryByTestId('file-viewer-placeholder')).toBeNull();
    fireEvent.click(await screen.findByTestId('file-tree-README.md'));
    expect(await screen.findByRole('dialog', { name: 'Visualizar arquivo' })).toBeTruthy();
    expect(screen.getByTestId('files-workspace')).toBeTruthy();
    expect(screen.queryByTestId('file-viewer-pane')).toBeNull();
  } finally {
    if (descriptor) Object.defineProperty(window, 'innerWidth', descriptor);
  }
});
