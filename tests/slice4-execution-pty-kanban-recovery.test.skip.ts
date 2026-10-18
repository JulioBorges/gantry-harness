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

      // Toggle Chat ⇄ Terminal mode and verify both terminal scrollback and structured turnBlocks with clickable paths
      const toggleRes = await fetch(
        `${baseUrl}/api/projects/${reg.project.id}/panes/pane-shell-1/toggle`,
        { method: 'POST' },
      ).then((r) => r.json());
      expect(toggleRes.pane.mode).toBe('chat');
      expect(toggleRes.pane.terminalBuffer).toContain('src/feature.ts');
      expect(toggleRes.pane.turnBlocks.length).toBeGreaterThan(0);
      const allClickable = toggleRes.pane.turnBlocks.flatMap(
        (b: { clickablePaths: string[] }) => b.clickablePaths,
      );
      expect(allClickable).toContain('src/feature.ts');

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

  it('executes /run deterministically with worktree isolation, protocol retry, Critic gateResult projection, serial merge, Kanban projection, Lesson Candidates, and Cleanup Authorization', async () => {
    const repoDir = initReadyGitRepo(tmpRoot, 'repo-run');
    let implementerAttempts = 0;

    const server = await createHarnessServer({
      gantryHome,
      stateRoot,
      profileRoot,
      port: 0,
      roleDispatcher: async (req) => {
        if (req.role === 'implementer') {
          implementerAttempts += 1;
          // Simulate a protocol failure on attempt 1 to test bounded 1-retry contract
          if (implementerAttempts === 1) {
            return { invalidSchemaField: true };
          }
          // Write a commit inside the isolated Issue Worktree
          const worktreePath = String(req.context?.worktreePath ?? repoDir);
          const branch = String(req.context?.branch ?? 'gantry/payments-01');
          fs.writeFileSync(
            path.join(worktreePath, 'src', 'paymentHandler.ts'),
            `export function handlePayment() { return 'ok'; }\n`,
            'utf-8',
          );
          execFileSync('git', ['add', 'src/paymentHandler.ts'], { cwd: worktreePath });
          execFileSync('git', ['commit', '-m', 'Implement paymentHandler'], { cwd: worktreePath });
          const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: worktreePath,
            encoding: 'utf-8',
          }).trim();
          return {
            worktree: worktreePath,
            branch,
            commits: [headSha],
            summary: 'Implemented paymentHandler with TDD',
            testsAdded: ['tests/paymentHandler.test.ts'],
            gatesResult: 'pass',
            decisions: [],
            blockers: [],
          };
        }
        if (req.role === 'reviewer') {
          return {
            blocking: [],
            nonBlocking: [
              {
                finding: 'Prefer explicit return type on exported handler',
                fix: 'Add string return type annotation',
              },
            ],
            summary: 'Standards and Spec review passed.',
          };
        }
        if (req.role === 'critic') {
          // Return a real gates.py-shaped gateResult containing prohibited `gates[].command` and `output_tail`
          // to verify projectCriticResult strips `gates` before runlog.py append!
          return {
            complete: true,
            criteria: [{ index: 0, met: true, evidence: 'src/paymentHandler.ts exports handlePayment' }],
            gatesVerdict: 'pass',
            gateResult: {
              verdict: 'pass',
              requirements: ['smoke-check'],
              gates: [
                {
                  name: 'smoke-check',
                  command: 'node -e "process.exit(0)"',
                  output_tail: 'ok',
                  status: 'pass',
                },
              ],
            },
            gateFailures: [],
            refutations: [],
            requiredFixes: [],
            decisionsForOperator: [],
          };
        }
        return {};
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const reg = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repoDir }),
      }).then((r) => r.json());

      const runRes = await fetch(`${baseUrl}/api/projects/${reg.project.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'payments',
          sessionId: reg.defaultSessionId,
        }),
      }).then((r) => r.json());

      expect(runRes.status).toBe('completed');
      expect(implementerAttempts).toBe(2); // 1 protocol failure + 1 bounded retry
      expect(runRes.completedIssues).toContain('payments#01');
      expect(runRes.decisionCard.kind).toBe('run_handoff');
      expect(runRes.decisionCard.prDraft.body).toContain('payments#01');

      // Verify Issue #01 is marked Status: done and ROADMAP.md is updated via roadmap.py done
      const issueText = fs.readFileSync(
        path.join(repoDir, '.scratch', 'payments', 'issues', '01-payment-handler.md'),
        'utf-8',
      );
      expect(issueText).toContain('Status: done');
      expect(issueText).toContain('- [x] Payment handler function exported');

      // Verify Kanban board places payments#01 in Done column
      const kanbanRes = await fetch(`${baseUrl}/api/projects/${reg.project.id}/kanban`).then((r) =>
        r.json(),
      );
      expect(kanbanRes.runs.length).toBeGreaterThan(0);
      const latestRun = kanbanRes.runs.find((r: { runId: string }) => r.runId === runRes.runId);
      expect(latestRun).toBeDefined();
      expect(latestRun.columns.Done.some((i: { ref: string }) => i.ref === 'payments#01')).toBe(true);

      // Authorize Cleanup Plan via cleanup.py --yes --plan-file
      const cleanupRes = await fetch(
        `${baseUrl}/api/projects/${reg.project.id}/runs/${runRes.runId}/cleanup`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rawPlanJson: runRes.decisionCard.cleanupPlan.rawPlanJson,
          }),
        },
      ).then((r) => r.json());
      expect(cleanupRes.authorized).toBe(true);

      // Accept a Lesson Candidate and verify it is written to AGENTS.md
      const lessonRes = await fetch(
        `${baseUrl}/api/projects/${reg.project.id}/runs/${runRes.runId}/lessons`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lessonId: 'lesson-1',
            decision: 'accept',
            targetFile: 'AGENTS.md',
            draftRule: 'Always export explicit return types on payment handlers.',
          }),
        },
      ).then((r) => r.json());
      expect(lessonRes.applied).toBe(true);
      expect(fs.readFileSync(path.join(repoDir, 'AGENTS.md'), 'utf-8')).toContain(
        'Always export explicit return types on payment handlers.',
      );
    } finally {
      await server.close();
    }
  });

  it('handles live steering (Queue & Send Now), Worktree Takeover, Critic correction pass, and Recovery Card (issueRoleReplacements) applying the new model selection', async () => {
    const repoDir = initReadyGitRepo(tmpRoot, 'repo-recovery');
    let shouldFailExecution = true;
    let criticCalls = 0;
    const promptsSeen: string[] = [];
    const modelsSeen: string[] = [];

    const server = await createHarnessServer({
      gantryHome,
      stateRoot,
      profileRoot,
      port: 0,
      roleDispatcher: async (req) => {
        promptsSeen.push(req.prompt);
        const sel = req.context?.selection as { model?: string } | undefined;
        if (sel?.model) modelsSeen.push(sel.model);
        if (req.role === 'implementer') {
          if (shouldFailExecution) {
            throw new Error('Simulated runtime execution failure: rate limit');
          }
          const worktreePath = String(req.context?.worktreePath ?? repoDir);
          const branch = String(req.context?.branch ?? 'gantry/payments-01');
          fs.writeFileSync(
            path.join(worktreePath, 'src', 'paymentHandler.ts'),
            `export function handlePayment() { return 'recovered-${promptsSeen.length}'; }\n`,
            'utf-8',
          );
          execFileSync('git', ['add', 'src/paymentHandler.ts'], { cwd: worktreePath });
          execFileSync('git', ['commit', '-m', `Implement pass ${promptsSeen.length}`], {
            cwd: worktreePath,
          });
          const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: worktreePath,
            encoding: 'utf-8',
          }).trim();
          return {
            worktree: worktreePath,
            branch,
            commits: [headSha],
            summary: 'Recovered implementation',
            testsAdded: ['tests/paymentHandler.test.ts'],
            gatesResult: 'pass',
            decisions: [],
            blockers: [],
          };
        }
        if (req.role === 'reviewer') {
          return { blocking: [], nonBlocking: [], summary: 'OK' };
        }
        if (req.role === 'critic') {
          criticCalls += 1;
          if (criticCalls === 1) {
            // First Critic pass refutes -> triggers 1 correction Implementer pass!
            return {
              complete: false,
              criteria: [{ index: 0, met: false, evidence: 'Missing edge case check' }],
              gatesVerdict: 'pass',
              gateResult: { verdict: 'pass', requirements: [] },
              gateFailures: [],
              refutations: ['Missing edge case check'],
              requiredFixes: ['Add edge case check'],
              decisionsForOperator: [],
            };
          }
          return {
            complete: true,
            criteria: [{ index: 0, met: true, evidence: 'Recovered and verified after correction pass' }],
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
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const reg = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repoDir }),
      }).then((r) => r.json());

      // First run hits execution failure -> pauses issue and emits issue_recovery Decision Card
      const pausedRun = await fetch(`${baseUrl}/api/projects/${reg.project.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'payments', sessionId: reg.defaultSessionId }),
      }).then((r) => r.json());

      expect(pausedRun.status).toBe('paused');
      expect(pausedRun.decisionCard.kind).toBe('issue_recovery');
      expect(pausedRun.decisionCard.issueRef).toBe('payments#01');
      expect(pausedRun.decisionCard.availableReplacements.length).toBeGreaterThan(0);

      // Queue a steering instruction for the next turn and test Takeover in Terminal -> Send Now steer
      const steerRes = await fetch(
        `${baseUrl}/api/projects/${reg.project.id}/runs/${pausedRun.runId}/steer`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            issueRef: 'payments#01',
            mode: 'queue',
            instruction: 'Use strict decimal rounding in paymentHandler',
          }),
        },
      ).then((r) => r.json());
      expect(steerRes.queued).toBe(true);

      const takeoverRes = await fetch(
        `${baseUrl}/api/projects/${reg.project.id}/runs/${pausedRun.runId}/takeover`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            issueRef: 'payments#01',
            worktreePath: pausedRun.decisionCard.worktree,
            launcher: 'shell',
          }),
        },
      ).then((r) => r.json());
      expect(takeoverRes.status).toBe('operator_takeover');
      expect(takeoverRes.pane.worktreePath).toBe(pausedRun.decisionCard.worktree);

      // Recover with an issueRoleReplacement -> records role.changed and run.resumed, applies openai/gpt-5.2-codex, runs Critic correction pass, and completes the Run!
      shouldFailExecution = false;
      const recoverRes = await fetch(
        `${baseUrl}/api/projects/${reg.project.id}/runs/${pausedRun.runId}/recover`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            issueRef: 'payments#01',
            role: 'implement',
            replacement: {
              harness: 'opencode',
              model: 'openai/gpt-5.2-codex',
            },
            sessionId: reg.defaultSessionId,
          }),
        },
      ).then((r) => r.json());

      expect(recoverRes.status).toBe('completed');
      expect(recoverRes.completedIssues).toContain('payments#01');
      expect(criticCalls).toBe(2); // 1 refutation + 1 accepted after correction pass
      expect(modelsSeen).toContain('openai/gpt-5.2-codex');
      expect(promptsSeen.some((p) => p.includes('Use strict decimal rounding'))).toBe(true);

      // Verify runlog recorded role.changed, run.resumed, and refutation
      const logFile = path.join(stateRoot, reg.project.unitId, 'runs', `${pausedRun.runId}.jsonl`);
      const events = fs
        .readFileSync(logFile, 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(events.some((e) => e.event === 'role.changed')).toBe(true);
      expect(events.some((e) => e.event === 'run.resumed')).toBe(true);
      expect(events.some((e) => e.event === 'refutation')).toBe(true);
    } finally {
      await server.close();
    }
  });
});
