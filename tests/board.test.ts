import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createHarnessServer, type HarnessServerInstance } from '../src/server/app.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const MINIMAL_BOARD_CLI = fs.readFileSync(path.join(FIXTURES, 'minimal-board-cli.py'), 'utf-8');
const PATH_GANTRY = fs.readFileSync(path.join(FIXTURES, 'path-gantry.py'), 'utf-8');

let server: HarnessServerInstance;
let home: string;
let savedPath: string | undefined;
const roots: string[] = [];

beforeAll(async () => {
  savedPath = process.env.PATH;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-board-home-'));
  server = await createHarnessServer({ port: 0, gantryHome: home });
});

afterEach(() => {
  process.env.PATH = savedPath;
  delete process.env.GANTRY_INVOCATION_LOG;
});

afterAll(async () => {
  process.env.PATH = savedPath;
  await server.close();
  fs.rmSync(home, { recursive: true, force: true });
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function gitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-board-repo-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  return root;
}

function writeIssue(root: string, name: string, body: string): void {
  const dir = path.join(root, '.scratch', 'sample', 'issues');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
}

function pinPack(root: string): string {
  const cliPath = path.join(root, '.agents', 'skills', 'gantry', 'scripts', 'cli.py');
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, MINIMAL_BOARD_CLI);
  fs.chmodSync(cliPath, 0o755);
  return cliPath;
}

async function register(root: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: path.basename(root), path: root }),
  });
  expect(response.ok).toBe(true);
  const body = await response.json() as { project: { id: string } };
  return body.project.id;
}

async function readBoard(projectId: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/projects/${projectId}/board`, { cache: 'no-store' });
}

it('reads the pinned pack board and maps blocked and done issues', async () => {
  const root = gitRepo();
  const cliPath = pinPack(root);
  fs.mkdirSync(path.join(root, '.scratch', 'sample'), { recursive: true });
  fs.writeFileSync(path.join(root, '.scratch', 'sample', 'spec.md'), '# Sample\n');
  writeIssue(root, '01-ready.md', `# Ready work

Type: issue
Status: ready-for-agent
Slice: \`sample#01\`

## Blocked by

None
`);
  writeIssue(root, '02-blocked.md', `# Blocked work

Type: issue
Status: ready-for-agent
Slice: \`sample#02\`

## Blocked by

- \`sample#01\`
`);
  writeIssue(root, '03-done.md', `# Finished work

Type: issue
Status: done
Slice: \`sample#03\`

## Blocked by

None
`);

  const projectId = await register(root);
  const response = await readBoard(projectId);
  expect(response.ok).toBe(true);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const board = await response.json();

  expect(board.pack).toEqual({ kind: 'pinned', cliPath });
  expect(board.execution).toEqual({ enabled: true, reason: null });
  expect(board.specs).toEqual([{ slug: 'sample', path: '.scratch/sample/spec.md', executable: false }]);
  const issues = Object.fromEntries(board.issues.map((issue: { ref: string }) => [issue.ref, issue]));
  expect(issues['sample#01']).toMatchObject({
    spec: 'sample', number: 1, title: 'Ready work', status: 'ready-for-agent', frontierBlocked: false, openBlockers: [],
  });
  expect(issues['sample#02']).toMatchObject({
    title: 'Blocked work', status: 'ready-for-agent', frontierBlocked: true, openBlockers: ['sample#01'],
  });
  expect(issues['sample#03']).toMatchObject({
    title: 'Finished work', status: 'done', frontierBlocked: false, openBlockers: [],
  });
  expect(board.frontier).toEqual(['sample#01']);

  const invocation = fs.readFileSync(path.join(root, 'board-invocations.log'), 'utf-8').trim();
  expect(invocation).toContain(cliPath);
  expect(invocation).toContain(`--cwd ${root} board`);
  expect(invocation).not.toContain('--json');

  writeIssue(root, '01-ready.md', `# Ready work

Type: issue
Status: done
Slice: \`sample#01\`

## Blocked by

None
`);
  const refreshed = await (await readBoard(projectId)).json();
  const again = Object.fromEntries(refreshed.issues.map((issue: { ref: string }) => [issue.ref, issue]));
  expect(again['sample#01'].status).toBe('done');
  expect(again['sample#02'].frontierBlocked).toBe(false);
  expect(again['sample#02'].openBlockers).toEqual([]);
  expect(refreshed.frontier).toEqual(['sample#02']);
  expect(fs.readFileSync(path.join(root, 'board-invocations.log'), 'utf-8').trim().split('\n')).toHaveLength(2);
});

it('falls back to gantry on PATH when the repository has no pinned pack', async () => {
  const root = gitRepo();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-board-bin-'));
  roots.push(bin);
  const executable = path.join(bin, 'gantry');
  const log = path.join(root, 'path-invocations.log');
  fs.writeFileSync(executable, PATH_GANTRY);
  fs.chmodSync(executable, 0o755);
  const projectId = await register(root);
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
  process.env.GANTRY_INVOCATION_LOG = log;
  const board = await (await readBoard(projectId)).json();

  expect(board.pack).toEqual({ kind: 'path', executable });
  expect(board.execution.enabled).toBe(true);
  expect(board.issues[0].title).toBe('Resolved from PATH');
  expect(board.frontier).toEqual(['path#01']);
  const invocation = fs.readFileSync(log, 'utf-8');
  expect(invocation).toContain(`board --cwd ${root}`);
  expect(invocation).not.toContain('--json');
});

it('disables execution when neither a pinned pack nor gantry on PATH resolves', async () => {
  const root = gitRepo();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-board-empty-path-'));
  roots.push(empty);
  const projectId = await register(root);
  process.env.PATH = empty;
  const response = await readBoard(projectId);
  const board = await response.json();

  expect(response.ok).toBe(true);
  expect(board.pack).toEqual({ kind: 'none' });
  expect(board.execution.enabled).toBe(false);
  expect(board.execution.reason).toMatch(/not on PATH/);
  expect(board.issues).toEqual([]);
  expect(board.specs).toEqual([]);
  expect(board.frontier).toEqual([]);
});
