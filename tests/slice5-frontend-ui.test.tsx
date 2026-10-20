// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHarnessServer, type HarnessServerInstance } from '../src/server/app.js';
import { App } from '../src/client/App.js';
import { resolveTerminalShell } from '../src/server/terminalSettings.js';

function initTestRepo(baseDir: string, name: string): string {
  const repoDir = path.join(baseDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), `# ${name}\n`, 'utf-8');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), `export const appName = '${name}';\n`, 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });
  return repoDir;
}

describe('Slice 5: React Frontend UI, Decision Cards, Chat ⇄ Terminal, Artifact Drawer, Kanban & Mobile Keybar', () => {
  let tmpRoot: string;
  let gantryHome: string;
  let stateRoot: string;
  let profileRoot: string;
  let server: HarnessServerInstance;
  let apiBaseUrl: string;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-harness-s5-'));
    gantryHome = path.join(tmpRoot, '.gantry');
    stateRoot = path.join(tmpRoot, '.gantry', 'state');
    profileRoot = path.join(tmpRoot, '.gantry', 'profiles');
    fs.mkdirSync(gantryHome, { recursive: true });

    server = await createHarnessServer({
      gantryHome,
      stateRoot,
      profileRoot,
      port: 0,
    });
    apiBaseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    await server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('renders the sidebar, opens a terminal instead of a conversation, and keeps the board available', async () => {
    const repoDir = initTestRepo(tmpRoot, 'ui-project');

    await fetch(`${apiBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoDir }),
    });

    render(<App apiBaseUrl={apiBaseUrl} />);

    // Wait for project to appear in sidebar
    await waitFor(() => {
      expect(screen.getByTestId('sidebar')).toBeTruthy();
      expect(within(screen.getByTestId('sidebar')).getByText('ui-project')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('open-factory-btn'));
    expect(screen.queryByTestId('chat-view')).toBeNull();
    expect(screen.queryByTestId('coordinator-input')).toBeNull();
    expect(screen.getByTestId('terminal-view')).toBeTruthy();

    // Spawn shell PTY launcher and verify Terminal view + mobile virtual terminal keybar
    fireEvent.click(screen.getByTestId('launcher-shell'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-view')).toBeTruthy();
      expect(screen.getByTestId('virtual-keybar')).toBeTruthy();
      expect(screen.getByText('esc')).toBeTruthy();
      expect(screen.getByText('^C')).toBeTruthy();
    });

    expect(screen.queryByTestId('open-kanban-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('open-board-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('issue-board')).toBeTruthy();
    });
  });

  it('opens a shell only from the new tab, in the project directory, and shows a live process as running', async () => {
    vi.stubGlobal('WebSocket', NodeWebSocket);
    const repoDir = initTestRepo(tmpRoot, 'terminal-project');
    const registered = await fetch(`${apiBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoDir }),
    }).then((response) => response.json());
    const projectId = registered.project.id as string;
    const panesUrl = `${apiBaseUrl}/api/projects/${projectId}/panes`;

    render(<App apiBaseUrl={apiBaseUrl} />);
    await screen.findAllByText('terminal-project');

    fireEvent.click(screen.getByTestId('open-factory-btn'));
    expect(screen.getByText('Use + Terminal para abrir o shell do sistema neste projeto.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('open-board-btn'));
    fireEvent.click(screen.getByTestId('chat-terminal-toggle'));
    expect(screen.getByTestId('terminal-view')).toBeTruthy();
    expect((await fetch(panesUrl).then((response) => response.json())).panes).toEqual([]);
    fireEvent.click(screen.getByTestId('open-settings-btn'));
    expect(within(screen.getByRole('dialog', { name: 'Configurações' })).queryByText(/Alternar conversa e terminal/)).toBeNull();

    const shell = await screen.findByLabelText('Shell do terminal');
    await waitFor(() => expect((screen.getByRole('option', { name: 'Sh' }) as HTMLOptionElement).disabled).toBe(false));
    fireEvent.change(shell, { target: { value: 'sh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar terminal' }));
    await screen.findByText(/Salvar terminal: resposta recebida/);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar configurações' }));

    fireEvent.click(screen.getByTestId('launcher-shell'));
    const runningTab = await screen.findByRole('button', { name: /Em execução/ });
    expect(runningTab.querySelector('.status-dot')?.classList.contains('done')).toBe(false);
    expect(runningTab.querySelector('.status-dot')?.classList.contains('working')).toBe(true);
    const opened = await fetch(panesUrl).then((response) => response.json());
    expect(opened.panes).toHaveLength(1);
    expect(opened.panes[0]).toMatchObject({
      launcher: 'shell',
      status: 'running',
      worktreePath: repoDir,
      command: resolveTerminalShell('sh'),
    });
    expect(screen.getByTestId('terminal-view').textContent).toContain(repoDir);

    fireEvent.click(screen.getByRole('button', { name: 'Encerrar terminal shell' }));
    await waitFor(async () => {
      expect((await fetch(panesUrl).then((response) => response.json())).panes).toEqual([]);
      expect(screen.queryByRole('button', { name: /Em execução/ })).toBeNull();
    });

    fireEvent.click(screen.getByTestId('launcher-shell'));
    await screen.findByRole('button', { name: /Em execução/ });
    fireEvent.change(screen.getByLabelText('Enviar ao terminal'), { target: { value: 'exit' } });
    fireEvent.submit(screen.getByLabelText('Enviar ao terminal').closest('form')!);
    const exitedTab = await screen.findByRole('button', { name: /Encerrado/ });
    expect(exitedTab.querySelector('.status-dot')?.classList.contains('done')).toBe(true);
    expect(exitedTab.querySelector('.status-dot')?.classList.contains('working')).toBe(false);
  });
});
