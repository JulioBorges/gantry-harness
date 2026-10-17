import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

it('starts the CLI under Bun and preserves SQLite state across restarts', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-harness-bun-'));
  const cliPath = path.resolve('src/cli.ts');
  const storePath = path.resolve('src/server/stateStore.ts');
  try {
    const output = execFileSync('bun', ['--eval', `
      import assert from 'node:assert/strict';
      import { runCli } from ${JSON.stringify(cliPath)};
      import { HarnessStateStore } from ${JSON.stringify(storePath)};
      const cwd = ${JSON.stringify(tmpRoot)};
      const gantryHome = ${JSON.stringify(path.join(tmpRoot, '.gantry'))};
      const result = await runCli([], { cwd, gantryHome, port: 0 });
      try {
        const response = await fetch(result.url + '/api/health');
        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, 'ok');
        assert.equal(result.focusedProjectPath, cwd);
        assert.equal(result.server.store.listProjects().length, 1);
      } finally {
        await result.server.close();
      }
      const store = new HarnessStateStore(gantryHome);
      try {
        const project = store.getProjectByPath(cwd);
        assert.ok(project);
        assert.equal(store.listSessions(project.id).length, 1);
        assert.equal(store.getWorkspaceLayout().activeProjectId, project.id);
        assert.equal(store.removeProject(project.id), true);
      } finally {
        store.close();
      }
      console.log('Bun startup and persistence OK');
    `], { encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(output).toContain('Bun startup and persistence OK');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
