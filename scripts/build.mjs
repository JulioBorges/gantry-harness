import { build } from 'esbuild';
import fs from 'node:fs';

const shared = {
  bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
};
await build({ ...shared, entryPoints: ['src/server/app.ts'], outfile: 'dist/server/app.js' });
// Keep the server module boundary: its installed asset paths are relative to dist/server.
await build({
  ...shared, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js', external: ['./server/app.js'],
});
const cli = fs.readFileSync('dist/cli.js', 'utf8');
fs.writeFileSync('dist/cli.js', `#!/usr/bin/env node\n${cli}`);
fs.chmodSync('dist/cli.js', 0o755);
