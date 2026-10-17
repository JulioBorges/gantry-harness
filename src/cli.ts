import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHarnessServer, type HarnessServerInstance } from './server/app.js';

export interface RunCliOptions {
  cwd?: string;
  gantryHome?: string;
  stateRoot?: string;
  profileRoot?: string;
  host?: string;
  port?: number;
  openBrowser?: boolean;
  requirePairingForRemote?: boolean;
}

export interface RunCliResult {
  reusedExistingServer: boolean;
  headless?: boolean;
  host: string;
  port: number;
  url: string;
  tailscaleUrl?: string;
  pairingCode?: string;
  focusedProjectPath: string;
  triggeredCommand: { subcommand: string; argument?: string } | null;
  server?: HarnessServerInstance;
}

function detectTailscaleIp(): string | null {
  try {
    const out = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf-8' }).trim();
    return out.split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<RunCliResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const gantryHome = path.resolve(options.gantryHome ?? path.join(os.homedir(), '.gantry'));
  const stateRoot = path.resolve(options.stateRoot ?? path.join(gantryHome, 'state'));
  const profileRoot = path.resolve(options.profileRoot ?? path.join(gantryHome, 'profiles'));

  const isHeadless = argv.includes('--headless');
  const isRemoteMode = argv.includes('--tailscale') || argv.includes('--lan');

  let explicitPort = options.port;
  let explicitHost = options.host;
  const positionalArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--headless' || arg === '--tailscale' || arg === '--lan') {
      continue;
    }
    if (arg === '--port' && argv[i + 1]) {
      explicitPort = Number(argv[++i]);
      continue;
    }
    if (arg === '--host' && argv[i + 1]) {
      explicitHost = argv[++i];
      continue;
    }
    positionalArgs.push(arg);
  }

  const subcommand = positionalArgs[0];
  const argument = positionalArgs.slice(1).join(' ') || undefined;

  const lockPath = path.join(gantryHome, 'harness', 'server.lock');

  // Check if an existing single-instance server is alive
  if (fs.existsSync(lockPath) && !isRemoteMode) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as {
        host: string;
        port: number;
      };
      const healthRes = await fetch(`http://127.0.0.1:${lock.port}/api/health`);
      if (healthRes.ok) {
        const dispatchRes = await fetch(`http://127.0.0.1:${lock.port}/api/cli/dispatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, subcommand, argument, headless: isHeadless }),
        }).then((r) => r.json());

        return {
          reusedExistingServer: true,
          headless: isHeadless,
          host: lock.host,
          port: lock.port,
          url: `http://127.0.0.1:${lock.port}`,
          focusedProjectPath: dispatchRes.focusedProjectPath,
          triggeredCommand: dispatchRes.triggeredCommand,
        };
      }
    } catch {
      // Stale lockfile; start a new server
    }
  }

  const bindHost = explicitHost ?? (isRemoteMode ? '0.0.0.0' : '127.0.0.1');
  const requirePairing = options.requirePairingForRemote ?? isRemoteMode;

  const server = await createHarnessServer({
    gantryHome,
    stateRoot,
    profileRoot,
    host: bindHost,
    port: explicitPort ?? 7400,
    requirePairingForRemote: requirePairing,
  });

  const dispatchRes = await fetch(`http://127.0.0.1:${server.port}/api/cli/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, subcommand, argument, headless: isHeadless }),
  }).then((r) => r.json());

  let pairingCode: string | undefined;
  let tailscaleUrl: string | undefined;
  if (requirePairing || bindHost === '0.0.0.0') {
    pairingCode = server.store.generatePairingCode();
    const tsIp = detectTailscaleIp();
    if (tsIp) {
      tailscaleUrl = `http://${tsIp}:${server.port}`;
    }
  }

  return {
    reusedExistingServer: false,
    headless: isHeadless,
    host: server.host,
    port: server.port,
    url: `http://127.0.0.1:${server.port}`,
    tailscaleUrl,
    pairingCode,
    focusedProjectPath: dispatchRes.focusedProjectPath,
    triggeredCommand: dispatchRes.triggeredCommand,
    server,
  };
}

const isMainModule =
  process.argv[1] &&
  fs.existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;

if (isMainModule) {
  runCli(process.argv.slice(2))
    .then((res) => {
      console.log(`gantry-harness listening on ${res.url} (bind: ${res.host}:${res.port})`);
      if (res.tailscaleUrl) {
        console.log(`Tailscale URL: ${res.tailscaleUrl}`);
      }
      if (res.pairingCode) {
        console.log(`One-Time Remote Pairing Code: ${res.pairingCode}`);
      }
      console.log(`Focused project: ${res.focusedProjectPath}`);
    })
    .catch((err) => {
      console.error('Failed to start gantry-harness:', err);
      process.exit(1);
    });
}
