// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { createHarnessServer, type HarnessServerInstance } from '../src/server/app.js';
import { App } from '../src/client/App.js';
import { BOARD_LANES } from '../src/boardModel.js';
import { installPinnedPack } from './packFixture.js';

function initGitRepo(root: string, name: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  fs.writeFileSync(
    path.join(repo, 'ROADMAP.md'),
    [
      '# Roadmap',
      '',
      '<!-- BEGIN GENERATED: spec progress -->',
      '<!-- END GENERATED: spec progress -->',
      '',
      '<!-- BEGIN GENERATED: issue checklist -->',
      '<!-- END GENERATED: issue checklist -->',
      '',
    ].join('\n'),
  );
  execFileSync('git', ['add', 'README.md', 'ROADMAP.md'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repo });
  return fs.realpathSync(repo);
}

function installRealPack(repo: string): string {
  return installPinnedPack(repo);
}

function writeExecutable(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf-8');
  fs.chmodSync(filePath, 0o755);
}

function writeArtifacts(repo: string): void {
  const specDir = path.join(repo, '.scratch', 'feat');
  const issuesDir = path.join(specDir, 'issues');
  fs.mkdirSync(issuesDir, { recursive: true });
  fs.writeFileSync(
    path.join(specDir, 'spec.md'),
    `# Feature Spec (spec 01)\n\nStatus: approved\n`,
    'utf-8',
  );
  fs.writeFileSync(
    path.join(issuesDir, '01-first-slice.md'),
    [
      '# First Slice',
      '',
      'Slice: `feat#01`',
      'Status: ready-for-agent',
      '',
      '## Blocked by',
      '',
      '- None',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] Implement first slice',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(issuesDir, '02-blocked-slice.md'),
    [
      '# Blocked Slice',
      '',
      'Slice: `feat#02`',
      'Status: ready-for-agent',
      '',
      '## Blocked by',
      '',
      '- `feat#01`',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] Implement blocked slice',
      '',
    ].join('\n'),
    'utf-8',
  );
  execFileSync('git', ['add', '.scratch'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'Add spec and issues'], { cwd: repo });
}

describe('Run supervisor and Issue execution (run-orchestration#03)', () => {
  let tmpRoot: string;
  let server: HarnessServerInstance;
  let apiBaseUrl: string;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-run-sup-'));
    const gantryHome = path.join(tmpRoot, '.gantry');
    server = await createHarnessServer({
      gantryHome,
      stateRoot: path.join(gantryHome, 'state'),
      profileRoot: path.join(gantryHome, 'profiles'),
      homeDir: tmpRoot,
      port: 0,
    });
    apiBaseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    cleanup();
    await server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function registerProject(repo: string): Promise<string> {
    const res = await fetch(`${apiBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repo }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    return body.project.id as string;
  }

  it('configures executable role commands through the workspace and lists only Issue Run worktrees', async () => {
    const repo = initGitRepo(tmpRoot, 'project-with-a-long-readable-name');
    installRealPack(repo);
    writeArtifacts(repo);
    execFileSync('git', ['add', '.agents'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'Pin pack'], { cwd: repo });
    const projectId = await registerProject(repo);
    render(<App apiBaseUrl={apiBaseUrl} />);
    const card = await screen.findByTestId('issue-card-feat#01');
    const beforeBranches = execFileSync('git', ['branch', '--list'], { cwd: repo }).toString();
    fireEvent.click(within(card).getByTestId('run-issue-feat#01'));
    const failure = await screen.findByTestId('run-error-feat#01');
    expect(failure.textContent).toContain('comando executável');
    expect(execFileSync('git', ['branch', '--list'], { cwd: repo }).toString()).toBe(beforeBranches);
    expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo }).toString().match(/^worktree /gm)).toHaveLength(1);
    expect(screen.queryByText('Worktrees')).toBeNull();
    expect(server.store.listRuns(projectId)).toEqual([]);
    fireEvent.click(within(failure).getByRole('button', { name: 'Configurar este projeto' }));
    await screen.findByLabelText('Comando para implement');
    expect(screen.queryByLabelText('Host para implement')).toBeNull();
    expect(screen.queryByLabelText('Modelo para implement')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar configurações do projeto' }));

    const executable = path.join(tmpRoot, 'role runner.py');
    writeExecutable(executable, `#!/usr/bin/env python3
import json, os, subprocess
from pathlib import Path
if os.environ['GANTRY_ROLE'] == 'implement':
    Path('delivered.txt').write_text('project command executed')
    subprocess.run(['git', 'add', 'delivered.txt'], check=True)
    subprocess.run(['git', 'commit', '-m', 'Deliver slice'], check=True)
print(json.dumps({'verdict':'pass'}))
`);
    const nonExecutable = path.join(tmpRoot, 'not-executable');
    fs.writeFileSync(nonExecutable, 'not executable');
    fs.chmodSync(nonExecutable, 0o644);
    fireEvent.click(screen.getByTestId('open-settings-btn'));
    fireEvent.click(screen.getByRole('tab', { name: 'Gantry' }));
    for (const role of ['plan', 'implement', 'review', 'critic']) {
      fireEvent.change(screen.getByLabelText(`Comando global para ${role}`), { target: { value: role === 'implement' ? nonExecutable : executable } });
    }
    fireEvent.click(screen.getByTestId('save-global-execution'));
    await waitFor(() => expect(server.store.getGlobalExecution().roles?.review.command).toBe(executable));
    fireEvent.click(screen.getByRole('button', { name: 'Fechar configurações' }));
    // A configured path that is not executable is refused before touching Git.
    const invalid = await fetch(`${apiBaseUrl}/api/projects/${projectId}/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'feat#01' }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).code).toBe('role-command-missing');
    expect(server.store.listRuns(projectId)).toEqual([]);
    expect(execFileSync('git', ['branch', '--list'], { cwd: repo }).toString()).toBe(beforeBranches);
    fireEvent.click(screen.getByTestId(`project-settings-${projectId}`));
    const input = await screen.findByLabelText('Comando para implement');
    fireEvent.change(input, { target: { value: executable } });
    fireEvent.click(screen.getByTestId('apply-project-commands'));
    await waitFor(async () => {
      const inspection = await (await fetch(`${apiBaseUrl}/api/projects/${projectId}/inspect`)).json();
      expect(inspection.roleCommands.implement.command).toBe(executable);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fechar configurações do projeto' }));
    fireEvent.click(screen.getByTestId(`project-settings-${projectId}`));
    expect((await screen.findByLabelText('Comando para implement') as HTMLInputElement).value).toBe(executable);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar configurações do projeto' }));
    fireEvent.click(within(screen.getByTestId('issue-card-feat#01')).getByTestId('run-issue-feat#01'));
    await waitFor(() => expect(server.store.listRuns(projectId).some((run) => run.status === 'ready-for-approval')).toBe(true), { timeout: 15000 });
    const run = server.store.listRuns(projectId).find((run) => run.status === 'ready-for-approval')!;
    expect(fs.readFileSync(path.join(run.worktree!, 'delivered.txt'), 'utf-8')).toBe('project command executed');
    expect(execFileSync('git', ['branch', '--list', 'gantry/feat-01'], { cwd: repo }).toString()).toContain('gantry/feat-01');
    const sidebar = screen.getByTestId('sidebar');
    const details = await within(sidebar).findByText('Worktrees');
    fireEvent.click(details);
    const rows = sidebar.querySelectorAll('.worktree-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('feat#01');
    expect(rows[0].textContent).toContain(run.worktree);
    expect(rows[0].textContent).not.toContain('main');
    expect(sidebar.querySelector('.project-row strong')?.textContent).toBe('project-with-a-long-readable-name');
    expect(within(sidebar).queryByRole('button', { name: /assumir/i })).toBeNull();
    expect(fs.existsSync(path.join(repo, '.gantry', 'config.json'))).toBe(false);
    expect(execFileSync('git', ['diff', '--name-only'], { cwd: repo }).toString()).toBe('');

    // Global commands alone also reach the real pack, in another registered project.
    const otherRepo = initGitRepo(tmpRoot, 'global-commands-project');
    installRealPack(otherRepo);
    writeArtifacts(otherRepo);
    execFileSync('git', ['add', '.agents'], { cwd: otherRepo });
    execFileSync('git', ['commit', '-m', 'Pin pack'], { cwd: otherRepo });
    fireEvent.click(screen.getByTestId('new-project-btn'));
    fireEvent.change(screen.getByLabelText('Diretório do projeto'), { target: { value: otherRepo } });
    fireEvent.click(screen.getByTestId('add-project-btn'));
    await screen.findAllByText('global-commands-project', {}, { timeout: 10000 });
    const otherId = server.store.listProjects().find((project) => project.path === otherRepo)!.id;
    await fetch(`${apiBaseUrl}/api/settings/execution`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roles: Object.fromEntries(['plan', 'implement', 'review', 'critic'].map((role) => [role, { command: executable }])) }),
    });
    fireEvent.click(screen.getByTestId(`project-settings-${otherId}`).parentElement!.querySelector('.project-row-select')!);
    await waitFor(() => expect(screen.getByTestId(`project-settings-${otherId}`).parentElement?.className).toContain('selected'));
    fireEvent.click(screen.getByTestId(`project-settings-${otherId}`));
    await screen.findByRole('heading', { name: 'Configurações de global-commands-project' });
    expect((await screen.findByLabelText('Comando para implement', {}, { timeout: 10000 }) as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Fechar configurações do projeto' }));
    const started = await (await fetch(`${apiBaseUrl}/api/projects/${otherId}/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'feat#01' }),
    })).json();
    expect(started.worktree).toBeTruthy();
    await waitFor(() => expect(server.store.listRuns(otherId).some((item) => item.status === 'ready-for-approval')).toBe(true), { timeout: 15000 });
  }, 40000);

  it('runs real cli.py execute through worktree, pause (corrections-exhausted), answer validation, continue, and ready-for-approval over HTTP, WS, and UI', async () => {
    const repo = initGitRepo(tmpRoot, 'real-cli-continue');
    installRealPack(repo);
    writeArtifacts(repo);

    const stateDir = path.join(tmpRoot, 'role-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const roleScript = path.join(tmpRoot, 'role-runner.py');
    writeExecutable(
      roleScript,
      `#!/usr/bin/env python3
import json, os, subprocess, sys, time
from pathlib import Path

role = os.environ.get("GANTRY_ROLE") or sys.argv[sys.argv.index("--role") + 1]
state_dir = Path(${JSON.stringify(stateDir)})
count_file = state_dir / f"{role}.count"
count = int(count_file.read_text()) + 1 if count_file.exists() else 1
count_file.write_text(str(count))

if role == "implement":
    (Path.cwd() / "implemented.txt").write_text(f"attempt-{count}\\n")
    subprocess.run(["git", "add", "implemented.txt"], cwd=Path.cwd(), check=True)
    subprocess.run(["git", "commit", "-m", f"implement attempt {count}"], cwd=Path.cwd(), check=True)
    sys.exit(0)

if role == "review":
    # Fail on first review so corrections-exhausted triggers after 1 correction budget
    if count == 1:
        print(json.dumps({"verdict": "fail"}))
        sys.exit(1)
    # Wait briefly on second review so test can observe Review lane
    gate = state_dir / "release-review"
    for _ in range(150):
        if gate.exists():
            break
        time.sleep(0.02)
    print(json.dumps({"verdict": "pass"}))
    sys.exit(0)

if role == "critic":
    gate = state_dir / "release-critic"
    for _ in range(150):
        if gate.exists():
            break
        time.sleep(0.02)
    print(json.dumps({"verdict": "pass"}))
    sys.exit(0)
`,
    );

    const gantryCfgDir = path.join(repo, '.gantry');
    fs.mkdirSync(gantryCfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(gantryCfgDir, 'config.json'),
      JSON.stringify(
        {
          budget: { corrections: 1 },
          checks: ['true'],
          execution: {
            roles: {
              implement: { command: roleScript },
              review: { command: roleScript },
              critic: { command: roleScript },
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
    execFileSync('git', ['add', '.gantry/config.json', '.agents'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'Configure roles'], { cwd: repo });

    const wsMessages: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    ws.on('message', (data) => {
      try {
        wsMessages.push(JSON.parse(String(data)));
      } catch {
        // ignore
      }
    });

    const projectId = await registerProject(repo);
    expect(
      execFileSync('git', ['ls-files', '.agents/skills/gantry/scripts/cli.py'], {
        cwd: repo,
        encoding: 'utf-8',
      }).trim(),
    ).toBe('.agents/skills/gantry/scripts/cli.py');

    const boardRes = await fetch(`${apiBaseUrl}/api/projects/${projectId}/board`);
    expect(boardRes.status).toBe(200);
    const board = await boardRes.json();
    expect(board.resolution).toBe('pinned');
    expect(board.executionEnabled).toBe(true);
    expect(board.issues.map((issue: { ref: string; title: string; frontierBlocked: boolean }) => ({
      ref: issue.ref,
      title: issue.title,
      frontierBlocked: issue.frontierBlocked,
    }))).toEqual([
      { ref: 'feat#01', title: 'First Slice', frontierBlocked: false },
      { ref: 'feat#02', title: 'Blocked Slice', frontierBlocked: true },
    ]);
    expect(board.specs).toEqual([{ slug: 'feat', path: '.scratch/feat/spec.md', executable: false }]);
    expect(board.frontier).toEqual(['feat#01']);

    render(<App apiBaseUrl={apiBaseUrl} />);

    const card01 = await screen.findByTestId('issue-card-feat#01');
    expect(card01.getAttribute('data-lane')).toBe('issues');
    expect(within(card01).getByTestId('issue-phase-feat#01').textContent).toBe('ready to agent');

    // Reject answering when no run or pause exists
    const noRunAnswerRes = await fetch(
      `${apiBaseUrl}/api/projects/${projectId}/runs/${encodeURIComponent('feat#01')}/answer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: 'continue' }),
      },
    );
    expect(noRunAnswerRes.status).toBe(404);

    // Start run via POST /api/projects/:id/runs
    const startRes = await fetch(`${apiBaseUrl}/api/projects/${projectId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'feat#01' }),
    });
    expect(startRes.status).toBe(200);
    const startedRun = await startRes.json();
    expect(startedRun.worktree).toBeTruthy();
    expect(fs.existsSync(startedRun.worktree)).toBe(true);
    expect(startedRun.branch).toBe('gantry/feat-01');

    // Wait for corrections-exhausted pause to arrive on the card
    await waitFor(() => {
      const pauseBox = screen.getByTestId('run-pause-feat#01');
      expect(within(pauseBox).getByText('corrections-exhausted')).toBeDefined();
    });

    const pausedCard = screen.getByTestId('issue-card-feat#01');
    expect(pausedCard.getAttribute('data-lane')).toBe('implement');
    expect(pausedCard.getAttribute('data-phase')).toBe('paused');
    expect(within(pausedCard).getByTestId('issue-phase-feat#01').textContent).toBe('paused');

    // Only continue and stop choices are rendered in the card
    const choicesBox = screen.getByTestId('run-pause-choices-feat#01');
    const choiceButtons = within(choicesBox).getAllByRole('button');
    expect(choiceButtons.map((b) => b.textContent)).toEqual(['continue', 'stop']);

    // Verify worktree event was broadcast over WS
    expect(
      wsMessages.some(
        (m) => m.type === 'run.event' && m.event === 'worktree' && m.ref === 'feat#01',
      ),
    ).toBe(true);
    expect(
      wsMessages.some(
        (m) =>
          m.type === 'run.paused' &&
          m.ref === 'feat#01' &&
          (m.pause as { reason?: string })?.reason === 'corrections-exhausted',
      ),
    ).toBe(true);

    // Verify invalid choice is rejected by POST /api/projects/:id/runs/:ref/answer
    const badChoiceRes = await fetch(
      `${apiBaseUrl}/api/projects/${projectId}/runs/${encodeURIComponent('feat#01')}/answer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: 'invalid-choice' }),
      },
    );
    expect(badChoiceRes.status).toBe(400);

    // Test follow-agent button opens the Run in the terminal/factory view
    fireEvent.click(screen.getByTestId('follow-agent-feat#01'));
    await waitFor(() => expect(screen.getByTestId('terminal-view')).toBeDefined());
    expect(screen.getByTestId('run-strip').textContent).toContain('feat#01');
    expect(screen.getByTestId('followed-run-worktree').textContent).toBe(startedRun.worktree);
    fireEvent.click(screen.getByText('Ver quadro →'));
    await waitFor(() => expect(screen.getByTestId('issue-board')).toBeDefined());

    // Click continue in the card; role-runner will pause briefly in review and critic so we can observe lanes
    fireEvent.click(screen.getByTestId('pause-choice-feat#01-continue'));

    // Observe the card move into the Review lane while review role runs
    await waitFor(() => {
      const reviewLane = screen.getByTestId('lane-review');
      expect(within(reviewLane).getByTestId('issue-card-feat#01')).toBeDefined();
    });
    fs.writeFileSync(path.join(stateDir, 'release-review'), 'ok');

    // Observe the card move into the Critic lane while critic role runs
    await waitFor(() => {
      const criticLane = screen.getByTestId('lane-critic');
      expect(within(criticLane).getByTestId('issue-card-feat#01')).toBeDefined();
    });
    fs.writeFileSync(path.join(stateDir, 'release-critic'), 'ok');

    // Wait for ready-for-approval terminal event
    await waitFor(() => {
      const card = screen.getByTestId('issue-card-feat#01');
      expect(card.getAttribute('data-phase')).toBe('ready-for-approval');
      expect(within(card).getByTestId('issue-phase-feat#01').textContent).toBe('ready for approval');
    });

    // Answering after pause has cleared is rejected with 409
    const lateAnswerRes = await fetch(
      `${apiBaseUrl}/api/projects/${projectId}/runs/${encodeURIComponent('feat#01')}/answer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: 'continue' }),
      },
    );
    expect(lateAnswerRes.status).toBe(409);

    // Persisted record in SQLite store reflects ready-for-approval
    const persisted = server.store.getRun(projectId, 'feat#01');
    expect(persisted?.status).toBe('ready-for-approval');
    expect(persisted?.terminalEvent).toBe('ready-for-approval');
    expect(persisted?.derivedPhase).toBe('ready-for-approval');

    ws.close();
  });

  it('handles stop on corrections-exhausted by keeping worktree and branch and marking the card stopped (not ready to agent, no extra lane)', async () => {
    const repo = initGitRepo(tmpRoot, 'real-cli-stop');
    installRealPack(repo);
    writeArtifacts(repo);

    const roleScript = path.join(tmpRoot, 'fail-review.py');
    writeExecutable(
      roleScript,
      `#!/usr/bin/env python3
import os, subprocess, sys
from pathlib import Path
role = os.environ.get("GANTRY_ROLE") or sys.argv[sys.argv.index("--role") + 1]
if role == "implement":
    (Path.cwd() / "work.txt").write_text("draft\\n")
    subprocess.run(["git", "add", "work.txt"], cwd=Path.cwd(), check=True)
    subprocess.run(["git", "commit", "-m", "draft work"], cwd=Path.cwd(), check=True)
    sys.exit(0)
sys.exit(1)
`,
    );

    fs.mkdirSync(path.join(repo, '.gantry'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.gantry', 'config.json'),
      JSON.stringify({
        budget: { corrections: 1 },
        checks: ['true'],
        execution: {
          roles: {
            implement: { command: roleScript },
            review: { command: roleScript },
            critic: { command: roleScript },
          },
        },
      }),
      'utf-8',
    );
    execFileSync('git', ['add', '.gantry/config.json', '.agents'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'Configure roles'], { cwd: repo });

    const projectId = await registerProject(repo);
    render(<App apiBaseUrl={apiBaseUrl} />);

    const runBtn = await screen.findByTestId('run-issue-feat#01');
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(screen.getByTestId('pause-choice-feat#01-stop')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('pause-choice-feat#01-stop'));

    await waitFor(() => {
      const card = screen.getByTestId('issue-card-feat#01');
      expect(card.getAttribute('data-phase')).toBe('stopped');
      expect(within(card).getByTestId('issue-phase-feat#01').textContent).toBe('stopped');
      expect(within(card).queryByText('ready to agent')).toBeNull();
    });

    // Ensure no extra lane was added beyond BOARD_LANES
    const renderedLanes = screen.getAllByTestId(/^lane-/);
    expect(renderedLanes.map((el) => el.getAttribute('data-testid'))).toEqual(
      BOARD_LANES.map((lane) => `lane-${lane}`),
    );

    const persisted = server.store.getRun(projectId, 'feat#01');
    expect(persisted?.status).toBe('stopped');
    expect(persisted?.terminalEvent).toBe('stopped');
    expect(persisted?.worktree).toBeTruthy();
    expect(fs.existsSync(persisted!.worktree!)).toBe(true);
    const branches = execFileSync('git', ['branch', '--list', 'gantry/feat-01'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim();
    expect(branches).toContain('gantry/feat-01');
  });

  it('surfaces open-blocker and branch-exists errors from real cli.py on the card without a crash and without a worktree', async () => {
    const repo = initGitRepo(tmpRoot, 'real-cli-errors');
    installRealPack(repo);
    writeArtifacts(repo);

    const noopRole = path.join(tmpRoot, 'noop-role.py');
    writeExecutable(noopRole, `#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n`);
    fs.mkdirSync(path.join(repo, '.gantry'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.gantry', 'config.json'),
      JSON.stringify({
        checks: ['true'],
        execution: {
          roles: {
            implement: { command: noopRole },
            review: { command: noopRole },
            critic: { command: noopRole },
          },
        },
      }),
      'utf-8',
    );
    execFileSync('git', ['add', '.gantry/config.json', '.agents'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'Configure roles'], { cwd: repo });

    // Pre-create branch gantry/feat-01 so feat#01 triggers branch-exists
    execFileSync('git', ['branch', 'gantry/feat-01'], { cwd: repo });

    const projectId = await registerProject(repo);
    render(<App apiBaseUrl={apiBaseUrl} />);

    await screen.findByTestId('issue-card-feat#01');

    // 1. Trigger open-blocker on feat#02 (which is blocked by feat#01)
    const blockerRes = await fetch(`${apiBaseUrl}/api/projects/${projectId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'feat#02' }),
    });
    expect(blockerRes.status).toBe(200);
    const blockerRun = await blockerRes.json();
    expect(blockerRun.status).toBe('failed');
    expect(blockerRun.worktree).toBeNull();
    expect(blockerRun.error?.code).toBe('open-blocker');
    expect(blockerRun.error?.openBlockers).toEqual(['feat#01']);

    await waitFor(() => {
      const errEl = screen.getByTestId('run-error-feat#02');
      expect(errEl.textContent).toContain('open-blocker');
      expect(errEl.textContent).toContain('feat#01');
    });
    const card02 = screen.getByTestId('issue-card-feat#02');
    expect(card02.getAttribute('data-lane')).toBe('issues');
    expect(card02.getAttribute('data-phase')).toBe('blocked');

    // 2. Trigger branch-exists on feat#01
    const branchRes = await fetch(`${apiBaseUrl}/api/projects/${projectId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'feat#01' }),
    });
    expect(branchRes.status).toBe(200);
    const branchRun = await branchRes.json();
    expect(branchRun.status).toBe('failed');
    expect(branchRun.worktree).toBeNull();
    expect(branchRun.error?.reason ?? branchRun.error?.code).toBe('branch-exists');

    await waitFor(() => {
      const errEl = screen.getByTestId('run-error-feat#01');
      expect(errEl.textContent).toContain('branch-exists');
    });
    const card01 = screen.getByTestId('issue-card-feat#01');
    expect(card01.getAttribute('data-lane')).toBe('issues');
    expect(fs.existsSync(path.join(repo, '.gantry', 'worktrees', 'gantry-feat-01'))).toBe(false);
  });

  it('maps Integrate role to Critic lane and marks non-JSON stdout, unanswered pause exit, and nonzero exit without terminal event as failed', async () => {
    const repo = initGitRepo(tmpRoot, 'unexpected-exits-repo');
    const cliPath = path.join(repo, '.agents', 'skills', 'gantry', 'scripts', 'cli.py');
    writeExecutable(
      cliPath,
      `#!/usr/bin/env python3
import json, sys, time
from pathlib import Path

args = sys.argv[1:]
repo = Path(args[args.index("--cwd") + 1]) if "--cwd" in args else Path.cwd()
cmd = args[args.index("--cwd") + 2] if "--cwd" in args else args[0]

if cmd == "board":
    print(json.dumps({
        "issues": [
            {"ref": "feat#01", "spec": "feat", "number": 1, "title": "Non-JSON", "status": "ready-for-agent", "path": ".scratch/feat/issues/01.md", "frontierBlocked": False, "openBlockers": []},
            {"ref": "feat#02", "spec": "feat", "number": 2, "title": "Unanswered Pause", "status": "ready-for-agent", "path": ".scratch/feat/issues/02.md", "frontierBlocked": False, "openBlockers": []},
            {"ref": "feat#03", "spec": "feat", "number": 3, "title": "Integrate Crash", "status": "ready-for-agent", "path": ".scratch/feat/issues/03.md", "frontierBlocked": False, "openBlockers": []},
        ],
        "specs": [{"slug": "feat", "path": ".scratch/feat/spec.md", "executable": False}],
        "frontier": ["feat#01", "feat#02", "feat#03"],
    }))
    sys.exit(0)

ref = args[-1]
wt = str(repo / ".worktrees" / ref.replace("#", "-"))
if ref == "feat#01":
    print(json.dumps({"event": "worktree", "branch": "gantry/feat-01", "worktree": wt, "pushed": False}), flush=True)
    print("PLAIN TEXT NON JSON LINE", flush=True)
    sys.exit(0)
elif ref == "feat#02":
    print(json.dumps({"event": "worktree", "branch": "gantry/feat-02", "worktree": wt, "pushed": False}), flush=True)
    print(json.dumps({"event": "pause", "reason": "plan-dirty", "choices": ["keep", "reset"], "branch": "gantry/feat-02", "worktree": wt, "pushed": False}), flush=True)
    sys.exit(0)
elif ref == "feat#03":
    rec_dir = repo / ".git" / "gantry-cli"
    rec_dir.mkdir(parents=True, exist_ok=True)
    (rec_dir / "feat--03.json").write_text(json.dumps({"ref": "feat#03", "branch": "gantry/feat-03", "phase": "Integrate", "spent": 0, "granted": 2}))
    print(json.dumps({"event": "worktree", "branch": "gantry/feat-03", "worktree": wt, "pushed": False, "role": "Integrate"}), flush=True)
    sys.exit(1)
`,
    );

    const projectId = await registerProject(repo);
    render(<App apiBaseUrl={apiBaseUrl} />);
    await screen.findByTestId('issue-card-feat#01');

    // 1. Non-JSON stdout line
    const res1 = await fetch(`${apiBaseUrl}/api/projects/${projectId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'feat#01' }),
    });
    expect(res1.status).toBe(200);
    await waitFor(() => {
      const r1 = server.store.getRun(projectId, 'feat#01');
      expect(r1?.status).toBe('failed');
      expect(r1?.error?.code).toBe('invalid-json');
    });

    // 2. Exit while pause is unanswered
    const res2 = await fetch(`${apiBaseUrl}/api/projects/${projectId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'feat#02' }),
    });
    expect(res2.status).toBe(200);
    await waitFor(() => {
      const r2 = server.store.getRun(projectId, 'feat#02');
      expect(r2?.status).toBe('failed');
      expect(r2?.error?.code).toBe('unanswered-pause-exit');
    });

    // 3. Integrate role maps to Critic lane and nonzero exit without terminal event marks failed
    const res3 = await fetch(`${apiBaseUrl}/api/projects/${projectId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'feat#03' }),
    });
    expect(res3.status).toBe(200);
    await waitFor(() => {
      const r3 = server.store.getRun(projectId, 'feat#03');
      expect(r3?.status).toBe('failed');
      expect(r3?.lane).toBe('critic');
      expect(r3?.error?.code).toBe('unexpected-exit');
    });

    await waitFor(() => {
      const criticLane = screen.getByTestId('lane-critic');
      const card03 = within(criticLane).getByTestId('issue-card-feat#03');
      expect(card03.getAttribute('data-phase')).toBe('failed');
      expect(within(card03).getByTestId('issue-phase-feat#03').textContent).toBe('failed');
    });
  });

  it('orchestrates Plan runs (run-orchestration#04): plan-approval with worktree file viewer, approve to ready-for-approval, plan-dirty try-again and reject cleanup, and spec-or-issue-exists pre-spawn refusal', async () => {
    const repo = initGitRepo(tmpRoot, 'real-cli-plan-runs');
    installRealPack(repo);
    writeArtifacts(repo);

    const stateDir = path.join(tmpRoot, 'plan-role-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const roleScript = path.join(tmpRoot, 'plan-role.py');
    writeExecutable(
      roleScript,
      `#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path

role = os.environ.get("GANTRY_ROLE") or sys.argv[sys.argv.index("--role") + 1]
state_dir = Path(${JSON.stringify(stateDir)})

if role == "plan":
    slug = os.environ["GANTRY_SLUG"]
    num = int(os.environ.get("GANTRY_ISSUE_NUMBER", "1"))
    issue_ref = f"{slug}#{num:02d}"
    spec_path = Path.cwd() / os.environ["GANTRY_SPEC_PATH"]
    issue_path = Path.cwd() / os.environ["GANTRY_ISSUE_PATH"]
    spec_path.parent.mkdir(parents=True, exist_ok=True)
    issue_path.parent.mkdir(parents=True, exist_ok=True)
    spec_path.write_text(f"# Planned Spec for {slug}\\n\\nStatus: draft\\n")
    issue_path.write_text(
        f"# Planned Issue for {slug}\\n\\nSlice: \`{issue_ref}\`\\nStatus: ready-for-agent\\n\\n## Blocked by\\n\\n- None\\n\\n## Acceptance criteria\\n\\n- [ ] Deliver {slug}\\n"
    )
    if (state_dir / f"dirty-{slug}").exists():
        # Leave working tree dirty so cli.py triggers plan-dirty pause
        (Path.cwd() / "uncommitted.txt").write_text("dirty\\n")
        sys.exit(0)
    uncommitted = Path.cwd() / "uncommitted.txt"
    if uncommitted.exists():
        uncommitted.unlink()
    subprocess.run(["git", "add", os.environ["GANTRY_SPEC_PATH"], os.environ["GANTRY_ISSUE_PATH"]], cwd=Path.cwd(), check=True)
    subprocess.run(["git", "commit", "-m", f"plan {issue_ref}"], cwd=Path.cwd(), check=True)
    sys.exit(0)

if role == "implement":
    (Path.cwd() / "implemented.txt").write_text("implemented\\n")
    subprocess.run(["git", "add", "implemented.txt"], cwd=Path.cwd(), check=True)
    subprocess.run(["git", "commit", "-m", "implement planned issue"], cwd=Path.cwd(), check=True)
    sys.exit(0)

if role in ("review", "critic"):
    print(json.dumps({"verdict": "pass"}))
    sys.exit(0)
`,
    );

    fs.mkdirSync(path.join(repo, '.gantry'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.gantry', 'config.json'),
      JSON.stringify({
        checks: ['true'],
        execution: {
          roles: {
            plan: { command: roleScript },
            implement: { command: roleScript },
            review: { command: roleScript },
            critic: { command: roleScript },
          },
        },
      }),
      'utf-8',
    );
    execFileSync('git', ['add', '.gantry/config.json', '.agents'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'Configure plan and issue roles'], { cwd: repo });

    const projectId = await registerProject(repo);
    render(<App apiBaseUrl={apiBaseUrl} />);
    await screen.findByTestId('issue-card-feat#01');

    // 1. Existing slug 'feat' refuses with spec-or-issue-exists without spawning a worktree
    const existsRes = await fetch(`${apiBaseUrl}/api/projects/${projectId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'feat', kind: 'plan' }),
    });
    expect(existsRes.status).toBe(200);
    const existsRun = await existsRes.json();
    expect(existsRun.status).toBe('failed');
    expect(existsRun.worktree).toBeNull();
    expect(existsRun.error?.code).toBe('spec-or-issue-exists');
    await waitFor(() => {
      expect(screen.getByTestId('run-error-feat').textContent).toContain('spec-or-issue-exists');
    });

    // 2. Start a new Plan Run via the board Plan input + button for 'new-auth'
    const slugInput = screen.getByTestId('plan-slug-input');
    fireEvent.change(slugInput, { target: { value: 'new-auth' } });
    fireEvent.click(screen.getByTestId('plan-affordance'));

    // Wait for the Plan Run to pause at plan-approval in the Plan lane with Spec card in Specs lane
    await waitFor(() => {
      const pauseBox = screen.getByTestId('run-pause-new-auth#01');
      expect(within(pauseBox).getByText('plan-approval')).toBeDefined();
    });

    const specCard = screen.getByTestId('spec-card-new-auth');
    expect(specCard.getAttribute('data-lane')).toBe('specs');
    expect(specCard.getAttribute('data-executable')).toBe('false');

    const planIssueCard = screen.getByTestId('issue-card-new-auth#01');
    expect(planIssueCard.getAttribute('data-lane')).toBe('plan');
    expect(planIssueCard.getAttribute('data-phase')).toBe('paused');

    const choicesBox = screen.getByTestId('run-pause-choices-new-auth#01');
    expect(within(choicesBox).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'approve',
      'reject',
    ]);

    // Verify worktree Spec and Issue links open the files from the worktree via /artifacts
    const specLink = screen.getByTestId('pause-spec-path-new-auth#01');
    const issueLink = screen.getByTestId('pause-issue-path-new-auth#01');
    expect(specLink.textContent).toBe('.scratch/new-auth/spec.md');
    expect(issueLink.textContent).toBe('.scratch/new-auth/issues/01-new-auth.md');

    const specArtRes = await fetch(
      `${apiBaseUrl}/api/projects/${projectId}/artifacts?path=${encodeURIComponent('.scratch/new-auth/spec.md')}`,
    );
    expect(specArtRes.status).toBe(200);
    const specArt = await specArtRes.json();
    expect(specArt.content).toContain('# Planned Spec for new-auth');

    const issueArtRes = await fetch(
      `${apiBaseUrl}/api/projects/${projectId}/artifacts?path=${encodeURIComponent('.scratch/new-auth/issues/01-new-auth.md')}`,
    );
    expect(issueArtRes.status).toBe(200);
    const issueArt = await issueArtRes.json();
    expect(issueArt.content).toContain('# Planned Issue for new-auth');

    // Answer 'approve' -> advances through Implement -> Review -> Critic -> ready-for-approval
    fireEvent.click(screen.getByTestId('pause-choice-new-auth#01-approve'));

    await waitFor(() => {
      const card = screen.getByTestId('issue-card-new-auth#01');
      expect(card.getAttribute('data-phase')).toBe('ready-for-approval');
      expect(card.getAttribute('data-lane')).toBe('critic');
    });

    // 3. Start another Plan Run 'dirty-plan' to exercise plan-dirty (try-again) and reject cleanup
    fs.writeFileSync(path.join(stateDir, 'dirty-dirty-plan'), '1', 'utf-8');
    const dirtyRes = await fetch(`${apiBaseUrl}/api/projects/${projectId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'dirty-plan', kind: 'plan' }),
    });
    expect(dirtyRes.status).toBe(200);

    await waitFor(() => {
      const pauseBox = screen.getByTestId('run-pause-dirty-plan#01');
      expect(within(pauseBox).getByText('plan-dirty')).toBeDefined();
    });
    const dirtyChoices = within(screen.getByTestId('run-pause-choices-dirty-plan#01'))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(dirtyChoices).toEqual(['try-again', 'reject']);

    const dirtyRun = server.store.getRun(projectId, 'dirty-plan#01');
    expect(dirtyRun?.worktree).toBeTruthy();
    const dirtyWorktree = dirtyRun!.worktree!;

    // Clear dirty marker and click 'try-again' -> plan role commits cleanly and reaches plan-approval
    fs.unlinkSync(path.join(stateDir, 'dirty-dirty-plan'));
    fireEvent.click(screen.getByTestId('pause-choice-dirty-plan#01-try-again'));

    await waitFor(() => {
      const pauseBox = screen.getByTestId('run-pause-dirty-plan#01');
      expect(within(pauseBox).getByText('plan-approval')).toBeDefined();
    });

    // Now click 'reject' -> worktree and branch are removed and Spec/Issue cards disappear from the board
    fireEvent.click(screen.getByTestId('pause-choice-dirty-plan#01-reject'));

    await waitFor(() => {
      expect(screen.queryByTestId('issue-card-dirty-plan#01')).toBeNull();
      expect(screen.queryByTestId('spec-card-dirty-plan')).toBeNull();
    });

    expect(fs.existsSync(dirtyWorktree)).toBe(false);
    const dirtyBranch = execFileSync('git', ['branch', '--list', 'gantry/dirty-plan-01'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim();
    expect(dirtyBranch).toBe('');
  });

  it('executes waves and parallel Runs independently (run-orchestration#05): frontier ordering, isolated worktrees/stdio, and frontierBlocked enforcement', async () => {
    const repo = initGitRepo(tmpRoot, 'real-cli-wave-parallel');
    installRealPack(repo);

    // Create two unblocked frontier issues (feat#01, feat#02) and one blocked issue (feat#03 blocked by feat#01)
    const specDir = path.join(repo, '.scratch', 'feat');
    const issuesDir = path.join(specDir, 'issues');
    fs.mkdirSync(issuesDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'spec.md'), '# Spec\n\nStatus: approved\n', 'utf-8');
    fs.writeFileSync(
      path.join(issuesDir, '01-first.md'),
      '# First\n\nSlice: `feat#01`\nStatus: ready-for-agent\n\n## Blocked by\n\n- None\n\n## Acceptance criteria\n\n- [ ] One\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(issuesDir, '02-second.md'),
      '# Second\n\nSlice: `feat#02`\nStatus: ready-for-agent\n\n## Blocked by\n\n- None\n\n## Acceptance criteria\n\n- [ ] Two\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(issuesDir, '03-third.md'),
      '# Third\n\nSlice: `feat#03`\nStatus: ready-for-agent\n\n## Blocked by\n\n- `feat#01`\n\n## Acceptance criteria\n\n- [ ] Three\n',
      'utf-8',
    );

    const stateDir = path.join(tmpRoot, 'wave-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const roleScript = path.join(tmpRoot, 'wave-role.py');
    writeExecutable(
      roleScript,
      `#!/usr/bin/env python3
import json, os, subprocess, sys, time
from pathlib import Path

role = os.environ.get("GANTRY_ROLE") or sys.argv[sys.argv.index("--role") + 1]
branch = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=Path.cwd(), text=True, capture_output=True, check=True).stdout.strip()
safe = branch.split("/")[-1]
state_dir = Path(${JSON.stringify(stateDir)})
count_file = state_dir / f"{safe}-{role}.count"
count = int(count_file.read_text()) + 1 if count_file.exists() else 1
count_file.write_text(str(count))

if role == "implement":
    (Path.cwd() / f"{safe}.txt").write_text(f"impl-{count}\\n")
    subprocess.run(["git", "add", f"{safe}.txt"], cwd=Path.cwd(), check=True)
    subprocess.run(["git", "commit", "-m", f"impl {safe} {count}"], cwd=Path.cwd(), check=True)
    sys.exit(0)

if role == "review":
    # Pause feat#01 via corrections-exhausted on its first review while feat#02 waits on a gate in Review
    if safe == "feat-01" and count == 1:
        print(json.dumps({"verdict": "fail"}))
        sys.exit(1)
    if safe == "feat-02":
        gate = state_dir / "release-feat-02-review"
        for _ in range(250):
            if gate.exists():
                break
            time.sleep(0.02)
    print(json.dumps({"verdict": "pass"}))
    sys.exit(0)

if role == "critic":
    print(json.dumps({"verdict": "pass"}))
    sys.exit(0)
`,
    );

    fs.mkdirSync(path.join(repo, '.gantry'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.gantry', 'config.json'),
      JSON.stringify({
        budget: { corrections: 1 },
        checks: ['true'],
        execution: {
          roles: {
            implement: { command: roleScript },
            review: { command: roleScript },
            critic: { command: roleScript },
          },
        },
      }),
      'utf-8',
    );
    execFileSync('git', ['add', '.scratch', '.gantry/config.json', '.agents'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'Setup wave repo'], { cwd: repo });

    await registerProject(repo);
    render(<App apiBaseUrl={apiBaseUrl} />);

    const card03 = await screen.findByTestId('issue-card-feat#03');
    expect(card03.getAttribute('data-lane')).toBe('issues');
    expect(card03.getAttribute('data-phase')).toBe('blocked');
    expect(within(card03).getByTestId('open-blocker').textContent).toBe('feat#01');
    const runBtn03 = within(card03).getByTestId('run-issue-feat#03') as HTMLButtonElement;
    expect(runBtn03.disabled).toBe(true);

    // Click top-level Run button to execute the wave
    fireEvent.click(screen.getByTestId('run-affordance'));

    // Wait until feat#01 pauses at corrections-exhausted and feat#02 is in Review lane
    await waitFor(
      () => {
        expect(screen.getByTestId('run-pause-feat#01')).toBeDefined();
        const reviewLane = screen.getByTestId('lane-review');
        expect(within(reviewLane).getByTestId('issue-card-feat#02')).toBeDefined();
      },
      { timeout: 5000 },
    );

    // Each Run has its own process, worktree, branch, and .git/gantry-cli/*.json record
    expect(fs.existsSync(path.join(repo, '.git', 'gantry-cli', 'feat--01.json'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.git', 'gantry-cli', 'feat--02.json'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.git', 'gantry-cli', 'feat--03.json'))).toBe(false);

    // Answering feat#01's pause does not unblock feat#02 (which is still waiting on release-feat-02-review)
    fireEvent.click(screen.getByTestId('pause-choice-feat#01-continue'));

    await waitFor(
      () => {
        const card01 = screen.getByTestId('issue-card-feat#01');
        expect(card01.getAttribute('data-phase')).toBe('ready-for-approval');
      },
      { timeout: 5000 },
    );

    // feat#02 is still running in Review lane until its gate is released
    expect(screen.getByTestId('issue-card-feat#02').getAttribute('data-lane')).toBe('review');

    // Release feat#02 and verify it completes to ready-for-approval while feat#03 stays blocked in Issues
    fs.writeFileSync(path.join(stateDir, 'release-feat-02-review'), 'ok');
    await waitFor(
      () => {
        const card02 = screen.getByTestId('issue-card-feat#02');
        expect(card02.getAttribute('data-phase')).toBe('ready-for-approval');
      },
      { timeout: 5000 },
    );
    expect(screen.getByTestId('issue-card-feat#03').getAttribute('data-lane')).toBe('issues');
  });

  it('supports Resume, Discard, and server restart reattach (run-orchestration#06)', async () => {
    const repo = initGitRepo(tmpRoot, 'real-cli-resume-discard-reattach');
    installRealPack(repo);
    writeArtifacts(repo);

    const stateDir = path.join(tmpRoot, 'resume-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const roleScript = path.join(tmpRoot, 'resume-role.py');
    writeExecutable(
      roleScript,
      `#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path

role = os.environ.get("GANTRY_ROLE") or sys.argv[sys.argv.index("--role") + 1]
state_dir = Path(${JSON.stringify(stateDir)})
count_file = state_dir / f"{role}.count"
count = int(count_file.read_text()) + 1 if count_file.exists() else 1
count_file.write_text(str(count))

if role == "implement":
    (Path.cwd() / "impl.txt").write_text(f"impl-{count}\\n")
    subprocess.run(["git", "add", "impl.txt"], cwd=Path.cwd(), check=True)
    subprocess.run(["git", "commit", "-m", f"impl {count}"], cwd=Path.cwd(), check=True)
    sys.exit(0)

if role == "review":
    if not (state_dir / "pass-review").exists():
        print(json.dumps({"verdict": "fail"}))
        sys.exit(1)
    print(json.dumps({"verdict": "pass"}))
    sys.exit(0)

if role == "critic":
    print(json.dumps({"verdict": "pass"}))
    sys.exit(0)
`,
    );

    fs.mkdirSync(path.join(repo, '.gantry'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.gantry', 'config.json'),
      JSON.stringify({
        budget: { corrections: 1 },
        checks: ['true'],
        execution: {
          roles: {
            implement: { command: roleScript },
            review: { command: roleScript },
            critic: { command: roleScript },
          },
        },
      }),
      'utf-8',
    );
    execFileSync('git', ['add', '.gantry/config.json', '.agents'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'Configure roles'], { cwd: repo });

    const projectId = await registerProject(repo);
    const view = render(<App apiBaseUrl={apiBaseUrl} />);

    // Start feat#01 and stop it on pause
    fireEvent.click(await screen.findByTestId('run-issue-feat#01'));
    await waitFor(() => expect(screen.getByTestId('pause-choice-feat#01-stop')).toBeDefined());
    fireEvent.click(screen.getByTestId('pause-choice-feat#01-stop'));

    // Stopped card offers Resume and Discard
    await waitFor(() => {
      expect(screen.getByTestId('resume-run-feat#01')).toBeDefined();
      expect(screen.getByTestId('discard-run-feat#01')).toBeDefined();
    });

    // Test restart reattach while stopped: delete from SQLite store and close/recreate server
    server.store.deleteRun(projectId, 'feat#01');
    const implementCountBeforeReattach = Number(
      fs.readFileSync(path.join(stateDir, 'implement.count'), 'utf-8'),
    );
    view.unmount();
    const savedGantryHome = server.gantryHome;
    await server.close();
    server = await createHarnessServer({
      gantryHome: savedGantryHome,
      stateRoot: path.join(savedGantryHome, 'state'),
      profileRoot: path.join(savedGantryHome, 'profiles'),
      homeDir: tmpRoot,
      port: 0,
    });
    apiBaseUrl = `http://127.0.0.1:${server.port}`;

    // Reattached from .git/gantry-cli/feat--01.json without spawning a new agent turn
    const implementCountAfterReattach = Number(
      fs.readFileSync(path.join(stateDir, 'implement.count'), 'utf-8'),
    );
    expect(implementCountAfterReattach).toBe(implementCountBeforeReattach);
    const reattachedRun = server.store.getRun(projectId, 'feat#01');
    expect(reattachedRun?.status).toBe('stopped');
    expect(reattachedRun?.lane).toBe('implement');

    const view2 = render(<App apiBaseUrl={apiBaseUrl} />);
    await waitFor(() => {
      expect(screen.getByTestId('resume-run-feat#01')).toBeDefined();
    });

    // Resume the stopped Run -> cli.py resumes in Implement lane, pauses at corrections-exhausted -> answer continue -> reaches ready-for-approval
    fs.writeFileSync(path.join(stateDir, 'pass-review'), '1');
    fireEvent.click(screen.getByTestId('resume-run-feat#01'));

    await waitFor(() => {
      expect(screen.getByTestId('pause-choice-feat#01-continue')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('pause-choice-feat#01-continue'));

    await waitFor(() => {
      const card = screen.getByTestId('issue-card-feat#01');
      expect(card.getAttribute('data-phase')).toBe('ready-for-approval');
    });

    // Reset phase to 'implement' in .git/gantry-cli/feat--01.json to test Discard via real cli.py discard
    const packRecordPath = path.join(repo, '.git', 'gantry-cli', 'feat--01.json');
    fs.writeFileSync(
      packRecordPath,
      JSON.stringify({
        ref: 'feat#01',
        branch: 'gantry/feat-01',
        phase: 'implement',
        spent: 1,
        granted: 1,
      }),
      'utf-8',
    );

    const discardRes = await fetch(
      `${apiBaseUrl}/api/projects/${projectId}/runs/${encodeURIComponent('feat#01')}/discard`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(discardRes.status).toBe(200);

    await waitFor(() => {
      const card = screen.getByTestId('issue-card-feat#01');
      expect(card.getAttribute('data-lane')).toBe('issues');
      expect(card.getAttribute('data-phase')).toBe('ready-to-agent');
    });
    expect(fs.existsSync(path.join(repo, '.gantry', 'worktrees', 'gantry-feat-01'))).toBe(false);
    expect(fs.existsSync(packRecordPath)).toBe(false);
    const branchAfterDiscard = execFileSync('git', ['branch', '--list', 'gantry/feat-01'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim();
    expect(branchAfterDiscard).toBe('');

    // Mark feat#01 as done on target and restart server -> card is in Done lane
    const issueFile = path.join(repo, '.scratch', 'feat', 'issues', '01-first-slice.md');
    fs.writeFileSync(
      issueFile,
      fs.readFileSync(issueFile, 'utf-8').replace('Status: ready-for-agent', 'Status: done'),
      'utf-8',
    );
    execFileSync('git', ['add', issueFile], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'Mark feat#01 done'], { cwd: repo });

    view2.unmount();
    await server.close();
    server = await createHarnessServer({
      gantryHome: savedGantryHome,
      stateRoot: path.join(savedGantryHome, 'state'),
      profileRoot: path.join(savedGantryHome, 'profiles'),
      homeDir: tmpRoot,
      port: 0,
    });
    apiBaseUrl = `http://127.0.0.1:${server.port}`;

    render(<App apiBaseUrl={apiBaseUrl} />);
    await waitFor(() => {
      const doneLane = screen.getByTestId('lane-done');
      const card = within(doneLane).getByTestId('issue-card-feat#01');
      expect(card.getAttribute('data-phase')).toBe('done');
    });
  });

  it('handles Approve, PR watching, closed-unmerged PR reopen, and merge-done cleanup (run-orchestration#07)', async () => {
    const repo = initGitRepo(tmpRoot, 'real-cli-approve-pr');
    const bareRemote = path.join(tmpRoot, 'remote.git');
    execFileSync('git', ['init', '--bare', bareRemote]);
    execFileSync('git', ['remote', 'add', 'origin', bareRemote], { cwd: repo });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repo });

    installRealPack(repo);
    writeArtifacts(repo);

    const roleScript = path.join(tmpRoot, 'pass-role.py');
    writeExecutable(
      roleScript,
      `#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path

role = os.environ.get("GANTRY_ROLE") or sys.argv[sys.argv.index("--role") + 1]
if role == "implement":
    (Path.cwd() / "feature.txt").write_text("shipped\\n")
    subprocess.run(["git", "add", "feature.txt"], cwd=Path.cwd(), check=True)
    subprocess.run(["git", "commit", "-m", "implement feature"], cwd=Path.cwd(), check=True)
    sys.exit(0)
print(json.dumps({"verdict": "pass"}))
sys.exit(0)
`,
    );

    // Fake gh binary in PATH so real cli.py approve can create/view PRs deterministically
    const binDir = path.join(tmpRoot, 'fake-bin');
    const ghStateFile = path.join(tmpRoot, 'gh-state.txt');
    fs.writeFileSync(ghStateFile, 'FAIL', 'utf-8');
    writeExecutable(
      path.join(binDir, 'gh'),
      `#!/usr/bin/env python3
import json, sys
from pathlib import Path

state = Path(${JSON.stringify(ghStateFile)}).read_text().strip()
args = sys.argv[1:]
if args[:2] == ["pr", "create"]:
    if state == "FAIL":
        sys.stderr.write("gh pr create failed: simulated error\\n")
        sys.exit(1)
    print("https://example.test/pr/42")
    sys.exit(0)
if args[:2] == ["pr", "view"]:
    if "--json" in args and "state" in args:
        print(json.dumps({"state": state}))
        sys.exit(0)
    print("https://example.test/pr/42")
    sys.exit(0)
sys.exit(0)
`,
    );
    const originalPath = process.env.PATH ?? '';
    process.env.PATH = `${binDir}:${originalPath}`;

    try {
      fs.mkdirSync(path.join(repo, '.gantry'), { recursive: true });
      fs.writeFileSync(
        path.join(repo, '.gantry', 'config.json'),
        JSON.stringify({
          checks: ['true'],
          execution: {
            roles: {
              implement: { command: roleScript },
              review: { command: roleScript },
              critic: { command: roleScript },
            },
          },
        }),
        'utf-8',
      );
      execFileSync('git', ['add', '.gantry/config.json', '.agents'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'Configure roles'], { cwd: repo });
      execFileSync('git', ['push', 'origin', 'main'], { cwd: repo });

      const projectId = await registerProject(repo);
      render(<App apiBaseUrl={apiBaseUrl} />);

      // Start feat#01 and wait for ready-for-approval
      fireEvent.click(await screen.findByTestId('run-issue-feat#01'));
      await waitFor(() => {
        const card = screen.getByTestId('issue-card-feat#01');
        expect(card.getAttribute('data-phase')).toBe('ready-for-approval');
      });

      // 1. Approve fails when gh fails -> keeps Run in ready-for-approval and surfaces error on the card
      fireEvent.click(screen.getByTestId('approve-run-feat#01'));
      await waitFor(() => {
        const errBox = screen.getByTestId('run-error-feat#01');
        expect(errBox.textContent).toContain('pull-request-failed');
      });
      expect(screen.getByTestId('issue-card-feat#01').getAttribute('data-phase')).toBe(
        'ready-for-approval',
      );
      // Verify the first approve already created the closing commit on the worktree branch
      const persistedAfterFail = server.store.getRun(projectId, 'feat#01');
      expect(persistedAfterFail?.status).toBe('ready-for-approval');
      const wtPath = persistedAfterFail!.worktree!;
      const headAfterFirstApprove = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: wtPath,
        encoding: 'utf-8',
      }).trim();

      // 2. Allow gh to succeed and repeat approve -> no duplicate closing commit (createdCommit: false) and stores prUrl
      fs.writeFileSync(ghStateFile, 'OPEN', 'utf-8');
      const approveRes = await fetch(
        `${apiBaseUrl}/api/projects/${projectId}/runs/${encodeURIComponent('feat#01')}/approve`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      expect(approveRes.status).toBe(200);
      const approvedRun = await approveRes.json();
      expect(approvedRun.status).toBe('approved-pending-merge');
      expect(approvedRun.prUrl).toBe('https://example.test/pr/42');
      expect(approvedRun.createdCommit).toBe(false);
      const headAfterSecondApprove = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: wtPath,
        encoding: 'utf-8',
      }).trim();
      expect(headAfterSecondApprove).toBe(headAfterFirstApprove);

      await waitFor(() => {
        expect(screen.getByTestId('run-pr-url-feat#01').textContent).toBe(
          'https://example.test/pr/42',
        );
      });

      // 3. Close PR without merging -> removes local worktree and moves card to Issues outside ready to agent and Done
      fs.writeFileSync(ghStateFile, 'CLOSED', 'utf-8');
      await fetch(
        `${apiBaseUrl}/api/projects/${projectId}/runs/${encodeURIComponent('feat#01')}/pr-closed`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );

      await waitFor(() => {
        const card = screen.getByTestId('issue-card-feat#01');
        expect(card.getAttribute('data-lane')).toBe('issues');
        expect(card.getAttribute('data-phase')).toBe('stopped');
        expect(within(card).queryByText('ready to agent')).toBeNull();
      });
      expect(fs.existsSync(wtPath)).toBe(false);

      // Reopen -> re-offers approval on the card
      fs.writeFileSync(ghStateFile, 'OPEN', 'utf-8');
      fireEvent.click(screen.getByTestId('reopen-pr-feat#01'));
      await waitFor(() => {
        const card = screen.getByTestId('issue-card-feat#01');
        expect(card.getAttribute('data-lane')).toBe('issues');
        expect(card.getAttribute('data-phase')).toBe('ready-for-approval');
        expect(screen.getByTestId('approve-run-feat#01')).toBeDefined();
      });

      // Re-approve re-attaches worktree and opens PR
      fireEvent.click(screen.getByTestId('approve-run-feat#01'));
      await waitFor(() => {
        const card = screen.getByTestId('issue-card-feat#01');
        expect(card.getAttribute('data-phase')).toBe('approved-pending-merge');
      });
      expect(fs.existsSync(wtPath)).toBe(true);

      // 4. Merge gantry/feat-01 into target (main) so Issue is done on target -> worktree & branch removed and card moves to Done
      execFileSync('git', ['merge', '--no-edit', 'gantry/feat-01'], { cwd: repo });
      fireEvent.click(screen.getByTestId('board-refresh'));

      await waitFor(() => {
        const doneLane = screen.getByTestId('lane-done');
        const card = within(doneLane).getByTestId('issue-card-feat#01');
        expect(card.getAttribute('data-phase')).toBe('done');
      });
      expect(fs.existsSync(wtPath)).toBe(false);
      const branchAfterMerge = execFileSync('git', ['branch', '--list', 'gantry/feat-01'], {
        cwd: repo,
        encoding: 'utf-8',
      }).trim();
      expect(branchAfterMerge).toBe('');
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
