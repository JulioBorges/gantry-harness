import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// npm's archive stores the macOS helper without an executable mode.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const architecture of ['darwin-arm64', 'darwin-x64']) {
    const helper = path.join(root, 'prebuilds', architecture, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}
