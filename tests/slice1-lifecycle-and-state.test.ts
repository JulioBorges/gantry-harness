import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { runCommand, resolveSkillDir, runGantryScript } from '../src/server/commandRunner.js';
import { createHarnessServer } from '../src/server/app.js';
import { runCli } from '../src/cli.js';

function initTempGitRepo(baseDir: string, name: string): string {
  const repoDir = path.join(baseDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), `# ${name}\n`, 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });
  return repoDir;
}

describe('Slice 1: Command Runner stdin Contract, 4-Home State Persistence & Single-Instance CLI', () => {
  let tmpRoot: string;
  let gantryHome: string;
  let stateRoot: string;
  let profileRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-harness-s1-'));
    gantryHome = path.join(tmpRoot, '.gantry');
    stateRoot = path.join(gantryHome, 'state');
    profileRoot = path.join(gantryHome, 'profiles');
    fs.mkdirSync(gantryHome, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('pipes stdin payloads to real Gantry runlog.py append without shell interpolation', async () => {
    const repoDir = initTempGitRepo(tmpRoot, 'repo-stdin');
    const skillResolution = resolveSkillDir(repoDir);
    expect(skillResolution.found).toBe(true);
    expect(skillResolution.skillDir).toBeTruthy();

    const unitRes = await runGantryScript('runlog.py', ['unit-id', '--cwd', repoDir, '--json'], {
      repoRoot: repoDir,
      skillDir: skillResolution.skillDir!,
    });
    expect(unitRes.exitCode).toBe(0);
    const { unitId } = JSON.parse(unitRes.stdout);
    expect(unitId).toMatch(/^[0-9a-f]{12}$/);

    const runId = 'run-slice1-test';
    const eventPayload = JSON.stringify({
      ts: new Date().toISOString(),
      run: runId,
      event: 'run.started',
      data: {
        repositoryRoot: repoDir,
        policyHash: 'abc123def456',
        tier: 'supported',
        staleAfterSeconds: 600,
      },
    });

    const appendRes = await runGantryScript(
      'runlog.py',
      ['append', unitId, runId, '--state-root', stateRoot],
      {
        repoRoot: repoDir,
        skillDir: skillResolution.skillDir!,
        input: eventPayload,
      },
    );
    expect(appendRes.exitCode).toBe(0);

    const logFile = path.join(stateRoot, unitId, 'runs', `${runId}.jsonl`);
    expect(fs.existsSync(logFile)).toBe(true);
    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).event).toBe('run.started');
  });

  it('prioritizes <repoRoot>/.agents/skills/gantry over ~/.agents/skills/gantry', () => {
    const repoDir = initTempGitRepo(tmpRoot, 'repo-skill-priority');
    const localSkillDir = path.join(repoDir, '.agents', 'skills', 'gantry', 'scripts');
    fs.mkdirSync(localSkillDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.agents', 'skills', 'gantry', 'SKILL.md'), '# Local Gantry\n');

    const resolved = resolveSkillDir(repoDir);
    expect(resolved.found).toBe(true);
    expect(resolved.source).toBe('repo');
    expect(resolved.skillDir).toBe(fs.realpathSync(path.join(repoDir, '.agents', 'skills', 'gantry')));
  });

  it('persists workspace state in ~/.gantry/harness outside git repos and restores it on restart', async () => {
    const repoA = initTempGitRepo(tmpRoot, 'project-alpha');
    const repoB = initTempGitRepo(tmpRoot, 'project-beta');

    const server1 = await createHarnessServer({
      gantryHome,
      stateRoot,
      profileRoot,
      port: 0,
    });
    const baseUrl1 = `http://127.0.0.1:${server1.port}`;

    // Register two projects
    const regA = await fetch(`${baseUrl1}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoA }),
    }).then((r) => r.json());
    expect(regA.project.path).toBe(repoA);

    const regB = await fetch(`${baseUrl1}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoB }),
    }).then((r) => r.json());

    // Update workspace layout state (activeProject, tabs, splitPanes, paneModes, scrollHistory)
    const layoutUpdate = {
      activeProjectId: regB.project.id,
      activeSessionId: regB.defaultSessionId,
      openTabs: [
        { id: 'tab-chat-1', title: 'Factory Chat', kind: 'factory', mode: 'chat' },
        { id: 'tab-pty-1', title: 'opencode', kind: 'agent', mode: 'terminal', harness: 'opencode' },
      ],
      splitPanes: [{ paneId: 'pane-main', tabId: 'tab-chat-1', direction: 'horizontal', ratio: 0.6 }],
      scrollPositions: { 'tab-chat-1': 420 },
    };

    const saveRes = await fetch(`${baseUrl1}/api/workspace/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layoutUpdate),
    });
    expect(saveRes.status).toBe(200);


    // Verify git working trees of repoA and repoB remain completely clean
    const statusA = execFileSync('git', ['status', '--porcelain'], { cwd: repoA, encoding: 'utf-8' });
    const statusB = execFileSync('git', ['status', '--porcelain'], { cwd: repoB, encoding: 'utf-8' });
    expect(statusA.trim()).toBe('');
    expect(statusB.trim()).toBe('');

    await server1.close();

    // Restart a fresh server instance against the same gantryHome
    const server2 = await createHarnessServer({
      gantryHome,
      stateRoot,
      profileRoot,
      port: 0,
    });
    const baseUrl2 = `http://127.0.0.1:${server2.port}`;

    const restored = await fetch(`${baseUrl2}/api/workspace/state`).then((r) => r.json());
    expect(restored.projects).toHaveLength(2);
    expect(restored.layout.activeProjectId).toBe(regB.project.id);
    expect(restored.layout.openTabs).toHaveLength(2);
    expect(restored.layout.openTabs[1].mode).toBe('terminal');
    expect(restored.layout.scrollPositions['tab-chat-1']).toBe(420);

    await server2.close();
  });

  it('reuses an already running server instance when CLI is invoked in another project directory', async () => {
    const repo1 = initTempGitRepo(tmpRoot, 'cli-repo-1');
    const repo2 = initTempGitRepo(tmpRoot, 'cli-repo-2');

    const server = await createHarnessServer({
      gantryHome,
      stateRoot,
      profileRoot,
      port: 0,
    });

    try {
      const cliResult = await runCli(['plan', 'Add caching layer'], {
        cwd: repo2,
        gantryHome,
        stateRoot,
        profileRoot,
        openBrowser: false,
      });

      expect(cliResult.reusedExistingServer).toBe(true);
      expect(cliResult.port).toBe(server.port);
      expect(cliResult.focusedProjectPath).toBe(repo2);
      expect(cliResult.triggeredCommand).toEqual({ subcommand: 'plan', argument: 'Add caching layer' });

      const state = await fetch(`http://127.0.0.1:${server.port}/api/workspace/state`).then((r) => r.json());
      const matched = state.projects.find((p: { path: string }) => p.path === repo2);
      expect(matched).toBeDefined();
      expect(state.layout.activeProjectId).toBe(matched.id);
    } finally {
      await server.close();
    }
  });

  it('supports one-time pairing codes for remote LAN/Tailscale access', async () => {
    const server = await createHarnessServer({
      gantryHome,
      stateRoot,
      profileRoot,
      port: 0,
      requirePairingForRemote: true,
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const pairGen = await fetch(`${baseUrl}/api/auth/pair/generate`, { method: 'POST' }).then((r) => r.json());
      expect(pairGen.code).toMatch(/^\d{6}$/);

      // Simulated remote request without token is rejected
      const unauthRes = await fetch(`${baseUrl}/api/workspace/state`, {
        headers: { 'X-Forwarded-For': '100.64.0.12' },
      });
      expect(unauthRes.status).toBe(401);

      // Verify one-time pairing code
      const verifyRes = await fetch(`${baseUrl}/api/auth/pair/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '100.64.0.12' },
        body: JSON.stringify({ code: pairGen.code }),
      }).then((r) => r.json());
      expect(verifyRes.token).toBeTruthy();

      // Reusing the same one-time code fails
      const replayRes = await fetch(`${baseUrl}/api/auth/pair/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '100.64.0.12' },
      });
      expect(replayRes.status).toBe(401);

      // Remote caller cannot generate its own pairing code without auth
      const remoteGenRes = await fetch(`${baseUrl}/api/auth/pair/generate`, {
        method: 'POST',
        headers: { 'X-Forwarded-For': '100.64.0.12' },
      });
      expect(remoteGenRes.status).toBe(401);

      // Authenticated remote request succeeds
      const authRes = await fetch(`${baseUrl}/api/workspace/state`, {
        headers: {
          'X-Forwarded-For': '100.64.0.12',
          Authorization: `Bearer ${verifyRes.token}`,
        },
      });
      expect(authRes.status).toBe(200);
    } finally {
      await server.close();
    }
  });

});
