import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { createHarnessServer } from '../src/server/app.js';

function initTempGitRepo(baseDir: string, name: string): string {
  const repoDir = path.join(baseDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), `# ${name}\n`, 'utf-8');
  fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), `# Agents\n\nFollow repo conventions.\n`, 'utf-8');
  execFileSync('git', ['add', 'README.md', 'AGENTS.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });
  return repoDir;
}

describe('Slice 2: Multi-Project Workspace, Sidebar Topology, Bootstrap, Discovery & Setup', () => {
  let tmpRoot: string;
  let gantryHome: string;
  let stateRoot: string;
  let profileRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-harness-s2-'));
    gantryHome = path.join(tmpRoot, '.gantry');
    stateRoot = path.join(gantryHome, 'state');
    profileRoot = path.join(gantryHome, 'profiles');
    fs.mkdirSync(gantryHome, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it.each(['~', '~/src/personal/myshoplist-saas', '~/src/personal/project with spaces'])(
    'expands the home directory when registering %s',
    async (inputPath) => {
      const repoDir = path.join(tmpRoot, inputPath.slice(2));
      fs.mkdirSync(repoDir, { recursive: true });
      const server = await createHarnessServer({ gantryHome, stateRoot, profileRoot, port: 0 });
      const homeMock = vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);
      try {
        const register = (projectPath: string) => fetch(`http://127.0.0.1:${server.port}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: projectPath }),
        });
        const response = await register(inputPath);
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(200);
        expect(body.project.path).toBe(repoDir);
        expect(server.store.getProjectByPath(repoDir)?.id).toBe(body.project.id);

        const absoluteResponse = await register(repoDir);
        expect(absoluteResponse.status).toBe(200);
        expect((await absoluteResponse.json()).project.id).toBe(body.project.id);
        expect(server.store.listProjects()).toHaveLength(1);
      } finally {
        homeMock.mockRestore();
        await server.close();
      }
    },
  );

  it('automatically loads project policy, specs, issues, worktree topology, and live status badges', async () => {
    const repoDir = initTempGitRepo(tmpRoot, 'repo-inspect');

    // Create a spec and an issue in .scratch/auth/
    const specDir = path.join(repoDir, '.scratch', 'auth', 'issues');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, '.scratch', 'auth', 'spec.md'),
      '# Spec: Auth\n\nType: spec\nStatus: ready-for-agent\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(specDir, '01-login.md'),
      '# Login Slice\n\nType: issue\nStatus: ready-for-agent\nSlice: `auth#01`\n',
      'utf-8',
    );
    fs.writeFileSync(path.join(repoDir, 'ROADMAP.md'), '# Roadmap\n\n- auth#01\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'Add spec and issue'], { cwd: repoDir });

    // Create a linked git worktree for auth#01
    const wtDir = path.join(tmpRoot, 'wt-auth-01');
    execFileSync('git', ['worktree', 'add', '-b', 'feat/auth-01', wtDir, 'main'], { cwd: repoDir });

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

      const inspect = await fetch(`${baseUrl}/api/projects/${reg.project.id}/inspect`).then((r) =>
        r.json(),
      );

      expect(inspect.unitId).toMatch(/^[0-9a-f]{12}$/);
      expect(inspect.agentsMd).toContain('Follow repo conventions.');
      expect(inspect.roadmapMd).toContain('auth#01');
      expect(inspect.specs).toHaveLength(1);
      expect(inspect.specs[0].slug).toBe('auth');
      expect(inspect.issues).toHaveLength(1);
      expect(inspect.issues[0].ref).toBe('auth#01');
      expect(inspect.worktrees.length).toBeGreaterThanOrEqual(2);
      const issueWt = inspect.worktrees.find((w: { branch: string }) => w.branch === 'feat/auth-01');
      expect(issueWt).toBeDefined();
      expect(issueWt.badgeState).toBe('idle');
    } finally {
      await server.close();
    }
  });

  it('emits cross-project real-time alerts over WebSocket and /api/alerts when a project transitions to needs input or blocked', async () => {
    const repoA = initTempGitRepo(tmpRoot, 'alert-repo-a');
    const repoB = initTempGitRepo(tmpRoot, 'alert-repo-b');

    const server = await createHarnessServer({
      gantryHome,
      stateRoot,
      profileRoot,
      port: 0,
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const regA = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repoA }),
      }).then((r) => r.json());

      const regB = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repoB }),
      }).then((r) => r.json());

      const wsEvents: Array<Record<string, unknown>> = [];
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      await new Promise<void>((resolve) => ws.once('open', () => resolve()));
      ws.on('message', (data) => {
        wsEvents.push(JSON.parse(data.toString()));
      });

      // Post a decision card in project B (causes project B to transition to 'needs input' and emit an alert)
      const msgRes = await fetch(`${baseUrl}/api/projects/${regB.project.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: regB.defaultSessionId,
          role: 'assistant',
          content: 'Decision required for Spec.',
          decisionCard: {
            kind: 'grilling_round',
            slug: 'payments',
            roundNumber: 1,
            questions: [
              {
                id: 'q1',
                title: '1. Currency',
                body: 'Which currencies are supported?',
                recommendedAnswer: 'USD and BRL',
              },
            ],
          },
        }),
      }).then((r) => r.json());

      const alertsRes = await fetch(`${baseUrl}/api/alerts`).then((r) => r.json());
      expect(alertsRes.alerts).toHaveLength(1);
      expect(alertsRes.alerts[0].projectId).toBe(regB.project.id);
      expect(alertsRes.alerts[0].badgeState).toBe('needs input');
      expect(alertsRes.alerts[0].messageId).toBe(msgRes.message.id);

      const alertWsEvent = wsEvents.find((e) => e.type === 'alert.triggered');
      expect(alertWsEvent).toBeDefined();
      expect(alertWsEvent?.projectId).toBe(regB.project.id);

      ws.close();
    } finally {
      await server.close();
    }
  });

  it('bootstraps Gantry skills into a repo, queries model discovery, previews policy diff without mutating files, and applies via setup.py', async () => {
    const repoDir = initTempGitRepo(tmpRoot, 'repo-setup');

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

      // Bootstrap Gantry skills into the repository
      const bootRes = await fetch(`${baseUrl}/api/projects/${reg.project.id}/bootstrap`, {
        method: 'POST',
      }).then((r) => r.json());
      expect(bootRes.installed).toBe(true);
      expect(fs.existsSync(path.join(repoDir, '.agents', 'skills', 'gantry', 'SKILL.md'))).toBe(true);

      // Query model discovery for opencode
      const discRes = await fetch(
        `${baseUrl}/api/projects/${reg.project.id}/discovery?harness=opencode`,
      ).then((r) => r.json());
      expect(discRes.harness).toBe('opencode');
      expect(Array.isArray(discRes.models)).toBe(true);
      expect(discRes.models.length).toBeGreaterThan(0);

      // Proposed policy with roles, git workflow, browser-validation check, guard hooks, and caveman
      const proposedPolicy = {
        execution: {
          hostHarness: 'opencode',
          roles: {
            plan: { harness: 'opencode', model: 'google/gemini-4-argon', effort: 'high' },
            implement: { harness: 'opencode', model: 'google/gemini-4-argon', effort: 'high' },
            review: { harness: 'opencode', model: 'openai/gpt-6.1-sol', effort: 'high' },
            critic: { harness: 'opencode', model: 'openai/gpt-6.1-sol', effort: 'high' },
          },
        },
        git: {
          target: 'main',
          prefix: 'gantry/',
          issueBranch: '{prefix}{spec}-{number:02d}',
        },
        checks: [
          { name: 'unit-tests', command: 'bun run test', mode: 'absolute' },
          { name: 'browser-validation', command: 'bun run test:e2e', mode: 'absolute' },
        ],
        hooks: {
          record: ['git commit'],
          deny: ['git push --force'],
        },
        caveman: true,
      };

      // Preview diff BEFORE applying: must NOT write .gantry/config.json on disk
      const previewRes = await fetch(`${baseUrl}/api/projects/${reg.project.id}/setup/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: proposedPolicy }),
      }).then((r) => r.json());

      expect(previewRes.diff).toContain('.gantry/config.json');
      expect(previewRes.diff).toContain('AGENTS.md');
      expect(previewRes.diff).toContain('browser-validation');
      expect(fs.existsSync(path.join(repoDir, '.gantry', 'config.json'))).toBe(false);

      // Apply tracked repository policy via setup.py
      const applyRepoRes = await fetch(`${baseUrl}/api/projects/${reg.project.id}/setup/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'repository', policy: proposedPolicy }),
      }).then((r) => r.json());

      expect(applyRepoRes.applied).toBe(true);
      expect(fs.existsSync(path.join(repoDir, '.gantry', 'config.json'))).toBe(true);
      const writtenConfig = JSON.parse(
        fs.readFileSync(path.join(repoDir, '.gantry', 'config.json'), 'utf-8'),
      );
      expect(writtenConfig.execution.hostHarness).toBe('opencode');
      expect(writtenConfig.checks[1].name).toBe('browser-validation');
      const agentsMd = fs.readFileSync(path.join(repoDir, 'AGENTS.md'), 'utf-8');
      expect(agentsMd).toContain('<!-- gantry:begin -->');

      // Apply machine-local personal profile via setup.py --personal without touching tracked files
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-m', 'Commit gantry policy'], { cwd: repoDir });

      const personalRes = await fetch(`${baseUrl}/api/projects/${reg.project.id}/setup/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'personal',
          hostHarness: 'codex',
          roles: {
            critic: { harness: 'codex', model: 'gpt-5.2-codex', effort: 'high' },
          },
        }),
      }).then((r) => r.json());

      expect(personalRes.applied).toBe(true);
      const profileFile = path.join(profileRoot, reg.project.unitId, 'execution.json');
      expect(fs.existsSync(profileFile)).toBe(true);
      const profileJson = JSON.parse(fs.readFileSync(profileFile, 'utf-8'));
      expect(profileJson.hostHarness).toBe('codex');
      expect(profileJson.roles.critic.model).toBe('gpt-5.2-codex');

      // Tracked git tree remains clean after saving personal profile
      const gitStatus = execFileSync('git', ['status', '--porcelain'], {
        cwd: repoDir,
        encoding: 'utf-8',
      });
      expect(gitStatus.trim()).toBe('');

      // Role resolution reflects personal profile override + derived role inheritance (plan-critic inherits from critic)
      const rolesRes = await fetch(`${baseUrl}/api/projects/${reg.project.id}/roles`).then((r) =>
        r.json(),
      );
      expect(rolesRes.roles.critic.harness).toBe('codex');
      expect(rolesRes.roles['plan-critic'].harness).toBe('codex');
      expect(rolesRes.roles.research.model).toBe('google/gemini-4-argon');
    } finally {
      await server.close();
    }
  });

  it('diagnoses git-ignored .gantry/config.json and dirty working trees with actionable remediation cards', async () => {
    const repoDir = initTempGitRepo(tmpRoot, 'repo-diagnose');
    fs.writeFileSync(path.join(repoDir, '.gitignore'), '.gantry/\n', 'utf-8');
    fs.writeFileSync(path.join(repoDir, 'uncommitted.txt'), 'dirty change\n', 'utf-8');

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

      const inspect = await fetch(`${baseUrl}/api/projects/${reg.project.id}/inspect`).then((r) =>
        r.json(),
      );
      expect(inspect.diagnostics.policyIgnored).toBe(true);
      expect(inspect.diagnostics.dirtyWorkingTree).toBe(true);
      expect(inspect.remediationCards.some((c: { kind: string }) => c.kind === 'ignored_policy')).toBe(
        true,
      );
      expect(inspect.remediationCards.some((c: { kind: string }) => c.kind === 'dirty_worktree')).toBe(
        true,
      );
    } finally {
      await server.close();
    }
  });
});
