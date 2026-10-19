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

  it('renders sidebar, registers projects, drives /plan Grilling -> Plan Approval -> /run -> Handoff Cards, toggles Chat ⇄ Terminal with mobile keybar, opens clickable file diffs, and renders Kanban columns', async () => {
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

    // Initiate /plan workflow from UI
    const goalInput = screen.getByTestId('coordinator-input') as HTMLInputElement;
    fireEvent.change(goalInput, { target: { value: '/plan Build UI dashboard' } });
    fireEvent.click(screen.getByTestId('coordinator-send-btn'));

    await screen.findByTestId('execute-prepared-command');
    expect(screen.queryByTestId('decision-card-grilling_round')).toBeNull();
    fireEvent.click(screen.getByTestId('execute-prepared-command'));

    // Wait for Grilling Decision Card and Alert Banner
    await waitFor(() => {
      expect(screen.getByTestId('decision-card-grilling_round')).toBeTruthy();
      expect(screen.getByTestId('alert-banner')).toBeTruthy();
    });

    // Submit Grilling answers -> transitions to Plan Approval Card
    fireEvent.click(screen.getByTestId('submit-grilling-btn'));

    await waitFor(
      () => {
        expect(screen.getByTestId('decision-card-plan_approval')).toBeTruthy();
      },
      { timeout: 15000 },
    );

    // Click Approve Plan -> transitions issues via roadmap.py
    fireEvent.click(screen.getByTestId('approve-plan-btn'));

    await waitFor(
      () => {
        expect(screen.getByTestId('start-run-btn')).toBeTruthy();
      },
      { timeout: 10000 },
    );

    // Commit the planned artifacts so the working tree is clean before clicking Start Run
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'Approve plan artifacts'], { cwd: repoDir });

    // Click Start Run -> executes full round loop and renders Run Handoff Card
    fireEvent.click(screen.getByTestId('start-run-btn'));

    await waitFor(
      () => {
        expect(screen.getByTestId('decision-card-run_handoff')).toBeTruthy();
      },
      { timeout: 25000 },
    );

    // Clickable file path opens the Artifact & Diff Drawer
    fs.writeFileSync(
      path.join(repoDir, 'src', 'app.ts'),
      `export const appName = 'ui-project';\nexport const extra = true;\n`,
      'utf-8',
    );
    fireEvent.click(screen.getAllByTestId('file-link-src/app.ts')[0]);

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Visualizar arquivo' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));
    expect(screen.getByRole('dialog', { name: 'Visualizar arquivo' }).textContent).toContain('+export const extra = true;');
    fireEvent.click(screen.getByRole('button', { name: 'Fechar visualização de arquivo' }));

    // Spawn shell PTY launcher and verify Terminal view + mobile virtual terminal keybar
    fireEvent.click(screen.getByTestId('launcher-shell'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-view')).toBeTruthy();
      expect(screen.getByTestId('virtual-keybar')).toBeTruthy();
      expect(screen.getByText('esc')).toBeTruthy();
      expect(screen.getByText('^C')).toBeTruthy();
    });

    // Open Embedded Kanban Board and verify all 8 Gantry columns
    fireEvent.click(screen.getByTestId('open-kanban-btn'));
    await waitFor(() => {
      const board = screen.getByTestId('kanban-board');
      expect(board).toBeTruthy();
      for (const col of ['Ready', 'Plan', 'Implement', 'Review', 'Critic', 'Integrate', 'Done', 'Blocked']) {
        expect(screen.getByTestId(`kanban-col-${col}`)).toBeTruthy();
      }
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
