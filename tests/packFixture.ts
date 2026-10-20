import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gantry-pack');

export interface PinnedPackSource {
  repository: string;
  commit: string;
  license: string;
  paths: string[];
}

export const PINNED_PACK_ROOT = fixtureRoot;
export const PINNED_PACK_SCRIPTS = path.join(fixtureRoot, 'scripts');
export const PINNED_PACK_SOURCE = JSON.parse(
  fs.readFileSync(path.join(fixtureRoot, 'SOURCE.json'), 'utf-8'),
) as PinnedPackSource;

const PIPELINE_SCRIPTS = ['cli.py', 'common.py', 'roadmap.py', 'acceptance.py'] as const;

/**
 * Copy the suite's pinned pack into a consumer repository.
 * Callers commit `.agents` so the temporary git repo holds the pin.
 */
export function installPinnedPack(repo: string, files: readonly string[] = PIPELINE_SCRIPTS): string {
  const destDir = path.join(repo, '.agents', 'skills', 'gantry', 'scripts');
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of files) {
    const src = path.join(PINNED_PACK_SCRIPTS, file);
    if (!fs.existsSync(src)) {
      throw new Error(
        `A cópia pinada do pack não tem ${file} (${PINNED_PACK_SOURCE.repository} @ ${PINNED_PACK_SOURCE.commit})`,
      );
    }
    const dest = path.join(destDir, file);
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
  }
  return path.join(destDir, 'cli.py');
}
