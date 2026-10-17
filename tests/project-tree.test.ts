import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../src/server/app.js';
import { readProjectTree } from '../src/server/projectTree.js';

function writeTree(root: string): void {
  fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Project\n');
  fs.writeFileSync(path.join(root, '.hidden'), 'secret\n');
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = true;\n');
  fs.writeFileSync(path.join(root, 'src', 'nested', 'inner.ts'), 'export const inner = true;\n');
  fs.writeFileSync(path.join(root, '.git', 'secret-marker.txt'), 'ignore\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'hidden-module.js'), 'module.exports = {};\n');
  const deep = path.join(root, ...'d1/d2/d3/d4/d5/d6/d7/d8/d9'.split('/'));
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(root, 'd1/d2/d3/d4/d5/d6/d7/d8/visible.txt'), 'seen\n');
  fs.writeFileSync(path.join(deep, 'too-deep.txt'), 'hidden\n');
}

it('lists one directory level with folders first, including hidden names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tree-'));
  try {
    writeTree(root);
    const listing = readProjectTree(root);
    expect(listing.path).toBe('');
    expect(listing.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      'directory:.git',
      'directory:.github',
      'directory:d1',
      'directory:node_modules',
      'directory:src',
      'file:.hidden',
      'file:README.md',
    ]);
    const src = readProjectTree(root, { path: 'src' });
    expect(src.path).toBe('src');
    expect(src.entries.map((entry) => entry.path)).toEqual(['src/nested', 'src/app.ts']);
    expect(readProjectTree(root, { path: 'src/nested' }).entries.map((entry) => entry.name)).toEqual(['inner.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('filters names without entering .git or node_modules and stops at the depth limit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tree-'));
  try {
    writeTree(root);
    expect(readProjectTree(root, { query: 'readme' }).entries.map((entry) => entry.path)).toEqual(['README.md']);
    expect(readProjectTree(root, { query: 'secret-marker' }).entries).toEqual([]);
    expect(readProjectTree(root, { query: 'hidden-module' }).entries).toEqual([]);
    expect(readProjectTree(root, { query: 'visible' }).entries.map((entry) => entry.path)).toEqual(['d1/d2/d3/d4/d5/d6/d7/d8/visible.txt']);
    expect(readProjectTree(root, { query: 'too-deep' }).entries).toEqual([]);
    expect(readProjectTree(root, { query: 'git' }).entries.map((entry) => entry.path)).toEqual(['.git', '.github']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('rejects paths that leave the project and omits escaping symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tree-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tree-out-'));
  try {
    writeTree(root);
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'nope\n');
    if (process.platform !== 'win32') fs.symlinkSync(outside, path.join(root, 'outside-link'));
    expect(() => readProjectTree(root, { path: '../outside' })).toThrow(/dentro do projeto/);
    expect(() => readProjectTree(root, { path: '/etc' })).toThrow(/inválido/);
    expect(() => readProjectTree(root, { path: 'src/missing' })).toThrow(/não encontrada/);
    if (process.platform !== 'win32') {
      expect(readProjectTree(root).entries.some((entry) => entry.name === 'outside-link')).toBe(false);
      expect(() => readProjectTree(root, { path: 'outside-link' })).toThrow(/dentro do projeto/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

it('serves the project tree over the project API', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tree-api-'));
  const server = await createHarnessServer({ gantryHome: path.join(root, 'home'), port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    writeTree(root);
    const registration = await (await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: root }),
    })).json();
    const projectId = registration.project.id;
    const listing = await (await fetch(`${base}/api/projects/${projectId}/tree`)).json();
    expect(listing.entries.find((entry: { name: string }) => entry.name === 'README.md')).toMatchObject({ kind: 'file', path: 'README.md' });
    expect(listing.entries.findIndex((entry: { kind: string }) => entry.kind === 'file')).toBeGreaterThan(
      listing.entries.findIndex((entry: { name: string }) => entry.name === 'src'),
    );
    const escaped = await fetch(`${base}/api/projects/${projectId}/tree?path=${encodeURIComponent('../outside')}`);
    expect(escaped.status).toBe(403);
    const filtered = await (await fetch(`${base}/api/projects/${projectId}/tree?query=app.ts`)).json();
    expect(filtered.entries.map((entry: { path: string }) => entry.path)).toEqual(['src/app.ts']);
    expect((await fetch(`${base}/api/projects/missing/tree`)).status).toBe(404);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
