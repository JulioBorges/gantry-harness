import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
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

describe('Slice 2: Multi-Project Workspace and Sidebar Topology', () => {
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
