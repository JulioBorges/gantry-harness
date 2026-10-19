import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { codexModelsFromDebugCatalog, discoverHarnessModels } from '../src/server/projectInspector.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('keeps visible Codex models from the debug catalog and drops hidden ones', () => {
  const models = codexModelsFromDebugCatalog({
    models: [
      {
        slug: 'gpt-5.2-codex',
        display_name: 'GPT 5.2 Codex',
        visibility: 'list',
        context_window: 200000,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      },
      { slug: 'codex-auto-review', display_name: 'Hidden', visibility: 'hide' },
    ],
  });
  expect(models).toEqual([
    {
      id: 'gpt-5.2-codex',
      name: 'GPT 5.2 Codex',
      contextWindow: 200000,
      supportedEfforts: ['low', 'high'],
    },
  ]);
});

it('lists Codex models when codex models refuses a non-terminal stdin', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-codex-discovery-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(repo, '.agents', 'skills', 'gantry', 'scripts'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(repo, '.agents', 'skills', 'gantry', 'scripts', 'discovery.py'), `#!/usr/bin/env python3
import json, sys
print(json.dumps({"error": "Missing discovery: codex models returned exit code 1: Error: stdin is not a terminal"}))
sys.exit(1)
`);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'debug' && args[1] === 'models') {
  console.log(JSON.stringify({ models: [
    { slug: 'gpt-5.2-codex', display_name: 'GPT 5.2 Codex', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] },
    { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
  ] }));
  process.exit(0);
}
console.error('Error: stdin is not a terminal');
process.exit(1);
`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);

  const catalog = await discoverHarnessModels(repo, 'codex');
  expect(catalog).toMatchObject({
    harness: 'codex',
    models: [{ id: 'gpt-5.2-codex', name: 'GPT 5.2 Codex', supportedEfforts: ['high'] }],
  });
});
