// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHarnessServer, type HarnessServerInstance } from '../src/server/app.js';
import { App } from '../src/client/App.js';

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
      commandPreparer: async (command, request) => ({ command, argument: request, explanation: 'Comando preparado para revisão.' }),
      roleDispatcher: async (req) => {
        if (req.role === 'requirement-critic') {
          return { blocking: [], findings: [] };
        }
        if (req.role === 'plan-critic') {
          return { acceptable: true, problems: [], frontierErrors: [] };
        }
        if (req.role === 'implementer') {
          const wt = String(req.context?.worktreePath ?? tmpRoot);
          const br = String(req.context?.branch ?? 'gantry/ui-slice-01');
          const fileName = `uiFeature-${Date.now()}-${Math.random().toString(36).slice(2, 5)}.ts`;
          fs.writeFileSync(path.join(wt, 'src', fileName), `export const built = true;\n`, 'utf-8');
          execFileSync('git', ['add', '.'], { cwd: wt });
          execFileSync('git', ['commit', '-m', `Implement ${fileName}`], { cwd: wt });
          const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf-8' }).trim();
          return {
            worktree: wt,
            branch: br,
            commits: [sha],
            summary: 'Implemented uiFeature in src/app.ts',
            testsAdded: [],
            gatesResult: 'pass',
            decisions: [],
            blockers: [],
          };
        }
        if (req.role === 'reviewer') {
          return { blocking: [], nonBlocking: [], summary: 'Looks good' };
        }
        if (req.role === 'critic') {
          return {
            complete: true,
            criteria: [{ index: 0, met: true, evidence: 'Verified uiFeature' }],
            gatesVerdict: 'pass',
            gateResult: { verdict: 'pass', requirements: [] },
            gateFailures: [],
            refutations: [],
            requiredFixes: [],
            decisionsForOperator: [],
          };
        }
        return {};
      },
    });
    server.store.updateProviderSettings({ mode: 'sdk', activeProvider: 'openai', providers: { openai: { apiKey: 'test-only', model: 'fixture' } } });
    apiBaseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('renders the sidebar, opens a terminal instead of a conversation, and keeps the board and setup available', async () => {
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

    // Open Gantry Setup Panel and preview policy diff
    fireEvent.click(screen.getByTestId('open-settings-btn'));
    fireEvent.click(screen.getByRole('tab', { name: 'Projeto' }));
    await waitFor(() => {
      expect(screen.getByTestId('setup-panel')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/Host do projeto/), { target: { value: 'opencode' } });
    fireEvent.click(screen.getByTestId('preview-setup-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('setup-diff-preview').textContent).toContain('.gantry/config.json');
    });
  });
});
