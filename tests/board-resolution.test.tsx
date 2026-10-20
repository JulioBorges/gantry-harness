// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHarnessServer, type HarnessServerInstance } from '../src/server/app.js';
import { App } from '../src/client/App.js';
import { BoardView } from '../src/client/BoardView.js';
import type { BoardSnapshot } from '../src/boardModel.js';

const BOARD = {
  issues: [
    {
      ref: 'pack#02',
      spec: 'pack',
      number: 2,
      title: 'Second',
      status: 'ready-for-agent',
      path: '.scratch/pack/issues/02.md',
      frontierBlocked: false,
      openBlockers: [],
    },
    {
      ref: 'pack#01',
      spec: 'pack',
      number: 1,
      title: 'First',
      status: 'done',
      path: '.scratch/pack/issues/01.md',
      frontierBlocked: false,
      openBlockers: [],
    },
    {
      ref: 'pack#03',
      spec: 'pack',
      number: 3,
      title: 'Third',
      status: 'ready-for-agent',
      path: '.scratch/pack/issues/03.md',
      frontierBlocked: true,
      openBlockers: ['pack#01'],
    },
  ],
  specs: [{ slug: 'pack', path: '.scratch/pack/spec.md', executable: false }],
  frontier: ['pack#02', 'pack#03'],
};

const PINNED_CLI = `#!/usr/bin/env python3
import json, sys
from pathlib import Path
if "--cwd" not in sys.argv or "board" not in sys.argv:
    sys.stderr.write("expected --cwd and board\\n")
    raise SystemExit(2)
repo = Path(sys.argv[sys.argv.index("--cwd") + 1])
(repo / ".invocation.json").write_text(json.dumps({"argv": sys.argv[1:], "script": sys.argv[0]}))
sys.stdout.write((repo / ".board.json").read_text())
`;

const PATH_GANTRY = `#!/bin/sh
printf '%s' "$0" > .path-bin
printf '%s' "$*" > .path-args
pwd > .path-cwd
while IFS= read -r line || [ -n "$line" ]; do
  printf '%s\\n' "$line"
done < .board.json
`;

const DECOY_GANTRY = `#!/bin/sh
touch .decoy-used
echo decoy >&2
exit 9
`;

function initRepo(root: string, name: string): string {
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

function writeExecutable(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
}

function pinPack(repo: string): string {
  const cli = path.join(repo, '.agents', 'skills', 'gantry', 'scripts', 'cli.py');
  writeExecutable(cli, PINNED_CLI);
  fs.writeFileSync(path.join(repo, '.board.json'), JSON.stringify(BOARD));
  return cli;
}

describe('Pack resolution and Issues/Specs board', () => {
  let tmpRoot: string;
  let server: HarnessServerInstance;
  let apiBaseUrl: string;
  let savedPath: string | undefined;

  beforeEach(async () => {
    savedPath = process.env.PATH;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-board-'));
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
    process.env.PATH = savedPath;
    await server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function register(repo: string): Promise<string> {
    const response = await fetch(`${apiBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repo }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    return body.project.id as string;
  }

  it('prefers the pinned cli.py board command over a gantry executable on PATH', async () => {
    const repo = initRepo(tmpRoot, 'pinned-repo');
    const cli = pinPack(repo);
    const decoyBin = path.join(tmpRoot, 'decoy-bin');
    writeExecutable(path.join(decoyBin, 'gantry'), DECOY_GANTRY);
    process.env.PATH = `${decoyBin}${path.delimiter}${savedPath ?? ''}`;
    const projectId = await register(repo);

    const first = await fetch(`${apiBaseUrl}/api/projects/${projectId}/board`).then((response) => response.json());
    expect(first.resolution).toBe('pinned');
    expect(first.executionEnabled).toBe(true);
    expect(first.explanation).toBeNull();
    expect(first.issues).toEqual(BOARD.issues);
    expect(first.specs).toEqual(BOARD.specs);
    expect(first.frontier).toEqual(BOARD.frontier);
    expect(fs.existsSync(path.join(repo, '.decoy-used'))).toBe(false);

    const invocation = JSON.parse(fs.readFileSync(path.join(repo, '.invocation.json'), 'utf-8'));
    expect(invocation.script).toBe(cli);
    expect(invocation.argv).toEqual(['--cwd', repo, 'board']);

    const refreshed = structuredClone(BOARD);
    refreshed.issues[1].title = 'First revised';
    fs.writeFileSync(path.join(repo, '.board.json'), JSON.stringify(refreshed));
    const second = await fetch(`${apiBaseUrl}/api/projects/${projectId}/board`).then((response) => response.json());
    expect(second.issues[1].title).toBe('First revised');
    expect(second.issues[0].title).toBe('Second');
  });

  it('falls back to gantry board on PATH when the repository has no pinned cli.py', async () => {
    const repo = initRepo(tmpRoot, 'path-repo');
    fs.writeFileSync(path.join(repo, '.board.json'), JSON.stringify(BOARD));
    const bin = path.join(tmpRoot, 'path-bin');
    const gantry = path.join(bin, 'gantry');
    writeExecutable(gantry, PATH_GANTRY);
    const projectId = await register(repo);
    process.env.PATH = bin;

    const body = await fetch(`${apiBaseUrl}/api/projects/${projectId}/board`).then((response) => response.json());
    expect(body.resolution).toBe('path');
    expect(body.executionEnabled).toBe(true);
    expect(body.issues.map((issue: { ref: string }) => issue.ref)).toEqual(['pack#02', 'pack#01', 'pack#03']);
    expect(body.frontier).toEqual(['pack#02', 'pack#03']);
    expect(fs.readFileSync(path.join(repo, '.path-bin'), 'utf-8')).toBe(gantry);
    expect(fs.readFileSync(path.join(repo, '.path-args'), 'utf-8')).toBe('board');
    expect(fs.realpathSync(fs.readFileSync(path.join(repo, '.path-cwd'), 'utf-8').trim())).toBe(repo);
  });

  it('disables run, plan and approve when neither the pinned pack nor PATH gantry resolves', async () => {
    const repo = initRepo(tmpRoot, 'empty-repo');
    const projectId = await register(repo);
    const emptyPath = path.join(tmpRoot, 'empty-path');
    fs.mkdirSync(emptyPath);
    process.env.PATH = emptyPath;

    const body = await fetch(`${apiBaseUrl}/api/projects/${projectId}/board`).then((response) => response.json());
    expect(body.resolution).toBe('none');
    expect(body.executionEnabled).toBe(false);
    expect(body.issues).toEqual([]);
    expect(body.specs).toEqual([]);
    expect(body.frontier).toEqual([]);
    expect(body.explanation).toMatch(/gantry/i);

    render(<App apiBaseUrl={apiBaseUrl} />);
    await screen.findAllByText('empty-repo');
    expect((await screen.findByTestId('run-affordance') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('plan-affordance') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('approve-affordance') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('execution-unavailable')).toBeNull();
    expect(screen.getByTestId('pack-missing').textContent).toMatch(/gantry/i);
    expect(screen.getByTestId('pack-missing').textContent).toMatch(/projeto|global/i);
    fireEvent.click(screen.getByTestId('chat-terminal-toggle'));
    expect(screen.getByTestId('terminal-view')).toBeTruthy();
    expect(screen.queryByTestId('pack-missing')).toBeNull();
    expect(screen.queryByTestId('execution-unavailable')).toBeNull();
    fireEvent.click(screen.getByTestId('open-files-btn'));
    expect(screen.getByTestId('files-workspace')).toBeTruthy();
    expect(screen.queryByTestId('pack-missing')).toBeNull();
    fireEvent.click(screen.getByTestId('open-factory-btn'));
    expect(screen.queryByTestId('pack-missing')).toBeNull();
    fireEvent.click(screen.getByTestId('open-board-btn'));
    expect(screen.getByTestId('pack-missing')).toBeTruthy();
  });

  it('uses the global skill cli.py when the repository has no pinned pack', async () => {
    const repo = initRepo(tmpRoot, 'global-repo');
    fs.writeFileSync(path.join(repo, '.board.json'), JSON.stringify(BOARD));
    const cli = path.join(tmpRoot, '.agents', 'skills', 'gantry', 'scripts', 'cli.py');
    writeExecutable(cli, PINNED_CLI);
    const projectId = await register(repo);

    const body = await fetch(`${apiBaseUrl}/api/projects/${projectId}/board`).then((response) => response.json());
    expect(body.resolution).toBe('global');
    expect(body.executionEnabled).toBe(true);
    const invocation = JSON.parse(fs.readFileSync(path.join(repo, '.invocation.json'), 'utf-8'));
    expect(invocation.script).toBe(cli);
  });

  it('renders ready, blocked and done cards from board data and refresh re-reads the repository', async () => {
    const repo = initRepo(tmpRoot, 'ui-repo');
    pinPack(repo);
    await register(repo);
    render(<App apiBaseUrl={apiBaseUrl} />);
    await screen.findAllByText('ui-repo');

    const ready = await screen.findByTestId('issue-card-pack#02');
    const done = screen.getByTestId('issue-card-pack#01');
    const blocked = screen.getByTestId('issue-card-pack#03');
    expect(ready.getAttribute('data-phase')).toBe('ready-to-agent');
    expect(ready.textContent).toContain('ready to agent');
    expect(done.getAttribute('data-phase')).toBe('done');
    expect(done.textContent).toContain('done');
    expect(blocked.getAttribute('data-phase')).toBe('blocked');
    expect(blocked.textContent).toContain('blocked');
    expect(within(blocked).getByTestId('open-blocker').textContent).toBe('pack#01');
    expect(within(done).queryByTestId('open-blocker')).toBeNull();

    const cards = within(screen.getByTestId('issue-cards')).getAllByRole('article');
    expect(cards.map((card) => card.getAttribute('data-ref'))).toEqual(['pack#02', 'pack#03']);
    expect(within(screen.getByTestId('lane-done')).getByTestId('issue-card-pack#01')).toBeTruthy();
    for (const lane of ['specs', 'issues', 'plan', 'implement', 'review', 'critic', 'done']) {
      expect(screen.getByTestId(`lane-${lane}`)).toBeTruthy();
    }
    expect(screen.getByTestId('board-lanes').className).toContain('board-lanes');

    const spec = screen.getByTestId('spec-card-pack');
    expect(spec.textContent).toContain('non-executable');
    expect(spec.getAttribute('data-executable')).toBe('false');
    expect(within(spec).getByRole('button', { name: 'Abrir documentação' })).toBeTruthy();
    expect(within(spec).queryByRole('button', { name: 'Run' })).toBeNull();
    expect((screen.getByTestId('run-affordance') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('plan-affordance') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('approve-affordance') as HTMLButtonElement).disabled).toBe(false);

    const revised = structuredClone(BOARD);
    revised.issues[0].title = 'Second revised';
    fs.writeFileSync(path.join(repo, '.board.json'), JSON.stringify(revised));
    fireEvent.click(screen.getByTestId('board-refresh'));
    await waitFor(() => expect(screen.getByTestId('issue-card-pack#02').textContent).toContain('Second revised'));
  });

  it('moves a running issue into Implement and keeps the agent prompt on the card', () => {
    const board: BoardSnapshot = {
      resolution: 'pinned',
      executionEnabled: true,
      explanation: null,
      issues: BOARD.issues,
      specs: BOARD.specs,
      frontier: BOARD.frontier,
    };
    const followed: string[] = [];
    const opened: string[] = [];
    render(
      <BoardView
        board={board}
        hasProject
        overlays={[{ ref: 'pack#02', lane: 'implement', operatorWaiting: true, runId: 'run-2' }]}
        issueInteractions={{ 'pack#02': <button type="button">continuar</button> }}
        onRefresh={() => undefined}
        onOpenPath={(path) => opened.push(path)}
        onFollow={(ref) => followed.push(ref)}
      />,
    );
    const lane = screen.getByTestId('lane-implement');
    expect(within(lane).getByTestId('issue-card-pack#02')).toBeTruthy();
    expect(within(lane).getByRole('button', { name: 'continuar' })).toBeTruthy();
    fireEvent.click(within(lane).getByRole('button', { name: 'Acompanhar agente' }));
    expect(followed).toEqual(['pack#02']);
    fireEvent.click(screen.getByTestId('open-spec-pack'));
    expect(opened).toEqual(['.scratch/pack/spec.md']);
    expect(within(screen.getByTestId('lane-issues')).queryByTestId('issue-card-pack#02')).toBeNull();
  });
});
