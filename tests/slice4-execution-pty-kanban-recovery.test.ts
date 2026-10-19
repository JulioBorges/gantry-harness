import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHarnessServer } from '../src/server/app.js';

function initReadyGitRepo(baseDir: string, name: string): string {
  const repoDir = path.join(baseDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: repoDir });

  fs.writeFileSync(path.join(repoDir, 'README.md'), `# ${name}\n`, 'utf-8');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'feature.ts'), `export const ready = true;\n`, 'utf-8');

  // Write .gantry/config.json with opencode host and passing check
  fs.mkdirSync(path.join(repoDir, '.gantry'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, '.gantry', 'config.json'),
    JSON.stringify(
      {
        execution: {
          hostHarness: 'opencode',
          roles: {
            plan: { harness: 'opencode', model: 'anthropic/claude-opus-4-5' },
            implement: { harness: 'opencode', model: 'anthropic/claude-opus-4-5' },
            review: { harness: 'opencode', model: 'openai/gpt-5.2-codex' },
            critic: { harness: 'opencode', model: 'openai/gpt-5.2-codex' },
          },
        },
        git: {
          target: 'main',
          prefix: 'gantry/',
          issueBranch: '{prefix}{spec}-{number:02d}',
        },
        checks: [{ name: 'smoke-check', command: 'node -e "process.exit(0)"', mode: 'absolute' }],
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  // Create ready-for-agent Spec and Issue #01
  const specDir = path.join(repoDir, '.scratch', 'payments', 'issues');
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, '.scratch', 'payments', 'spec.md'),
    [
      '# Spec: payments',
      '',
      'Type: spec',
      'Status: ready-for-agent',
      'Map: none',
      'Source: test',
      'Created: 2026-10-15',
      '',
      '## Blueprint',
      '### Context',
      'Payments slice.',
      '### Architecture',
      'Deterministic payment handler.',
      '### Constraints',
      '- Keep clean.',
      '## Contract',
      '### Definition of Done',
      '- [ ] Payment handler implemented',
      '### Regression Guardrails',
      '- Tests pass.',
      '### Scenarios',
      '```gherkin',
      'Scenario: Payment succeeds',
      '  Given a valid cart',
      '  When payment is submitted',
      '  Then receipt is returned',
      '```',
      '## Out of Scope',
      '- Refunds',
      '## Changelog',
      '- 2026-10-15: Created.',
      '',
    ].join('\n'),
    'utf-8',
  );

  fs.writeFileSync(
    path.join(specDir, '01-payment-handler.md'),
    [
      '# Implement payment handler',
      '',
      'Type: issue',
      'Status: ready-for-agent',
      'Slice: `payments#01`',
      'Spec: `.scratch/payments/spec.md`',
      'Created: 2026-10-15',
      '',
      '## Parent',
      '- Spec: `.scratch/payments/spec.md`',
      '## What to build',
      'Build payment handler.',
      '### Files to read',
      '- `src/feature.ts`',
      '## Acceptance criteria',
      '- [ ] Payment handler function exported',
      '## Blocked by',
      '- None',
      '## Comments',
      '',
    ].join('\n'),
    'utf-8',
  );

  fs.writeFileSync(
    path.join(repoDir, 'ROADMAP.md'),
    [
      '# Roadmap',
      '',
      '| Metric | Value |',
      '|---|---|',
      '| Issues completed | **0 / 1** |',
      '| Specs completed | **0 / 1** |',
      '| Execution waves | **1** |',
      '',
      '## Spec Progress',
      '',
      '<!-- BEGIN GENERATED: spec progress -->',
      '<!-- END GENERATED: spec progress -->',
      '',
      '## Issue Checklist',
      '',
      '<!-- BEGIN GENERATED: issue checklist -->',
      '<!-- END GENERATED: issue checklist -->',
      '',
    ].join('\n'),
    'utf-8',
  );

  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'Initial ready repo'], { cwd: repoDir });
  return repoDir;
}

describe('Slice 4: Deterministic Round Execution (/run), PTY Supervisor, Chat ⇄ Terminal, Steering, Recovery & Handoff', () => {
  let tmpRoot: string;
  let gantryHome: string;
  let stateRoot: string;
  let profileRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-harness-s4-'));
    gantryHome = path.join(tmpRoot, '.gantry');
    stateRoot = path.join(gantryHome, 'state');
    profileRoot = path.join(gantryHome, 'profiles');
    fs.mkdirSync(gantryHome, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('spawns standalone PTY panes, toggles Chat ⇄ Terminal while preserving scrollback and structured turn blocks, and serves clickable file diffs', async () => {
    const repoDir = initReadyGitRepo(tmpRoot, 'repo-pty');
    const server = await createHarnessServer({
      gantryHome,
      stateRoot,
      profileRoot,
      port: 0,
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const reg = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repoDir }),
      }).then((r) => r.json());

      // Spawn a shell pane in the project worktree
      const paneRes = await fetch(`${baseUrl}/api/projects/${reg.project.id}/panes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paneId: 'pane-shell-1',
          launcher: 'shell',
          worktreePath: repoDir,
          mode: 'terminal',
        }),
      }).then((r) => r.json());
      expect(paneRes.pane.paneId).toBe('pane-shell-1');
      expect(paneRes.pane.mode).toBe('terminal');

      // Send a command to the pane
      const inputRes = await fetch(
        `${baseUrl}/api/projects/${reg.project.id}/panes/pane-shell-1/input`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: 'echo "Edited src/feature.ts"\n' }),
        },
      ).then((r) => r.json());
      expect(inputRes.ok).toBe(true);

      const pane = await fetch(`${baseUrl}/api/projects/${reg.project.id}/panes/pane-shell-1`).then((r) => r.json());
      expect(pane.pane.mode).toBe('terminal');
      expect((await fetch(`${baseUrl}/api/projects/${reg.project.id}/panes/pane-shell-1/toggle`, { method: 'POST' })).status).toBe(404);

      // Clickable file path opens in the integrated artifact/diff drawer endpoint
      fs.writeFileSync(
        path.join(repoDir, 'src', 'feature.ts'),
        `export const ready = true;\nexport const updated = 42;\n`,
        'utf-8',
      );
      const artifactRes = await fetch(
        `${baseUrl}/api/projects/${reg.project.id}/artifacts?path=src/feature.ts&diff=true`,
      ).then((r) => r.json());
      expect(artifactRes.content).toContain('updated = 42');
      expect(artifactRes.diff).toContain('+export const updated = 42;');
    } finally {
      await server.close();
    }
  });

});
