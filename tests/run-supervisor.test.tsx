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

function findRealPackScriptsDir(): string {
  const candidates = [
    path.join(os.homedir(), '.agents', 'skills', 'gantry', 'scripts'),
    '/home/julio/src/gantry/.agents/skills/gantry/scripts',
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'cli.py')) && fs.existsSync(path.join(dir, 'common.py'))) {
      return dir;
    }
  }
  throw new Error('Could not locate real cli.py and common.py for integration tests');
}

function initGitRepo(root: string, name: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repo });
  return fs.realpathSync(repo);
}

function installRealPack(repo: string): string {
  const srcDir = findRealPackScriptsDir();
  const destDir = path.join(repo, '.agents', 'skills', 'gantry', 'scripts');
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of ['cli.py', 'common.py']) {
    const dest = path.join(destDir, file);
    fs.copyFileSync(path.join(srcDir, file), dest);
    fs.chmodSync(dest, 0o755);
  }
  return path.join(destDir, 'cli.py');
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
});
