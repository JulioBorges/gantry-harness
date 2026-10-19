import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarnessServer } from '../src/server/app.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const board = {
  issues: [
    {
      ref: 'pack#02',
      spec: 'pack',
      number: 2,
      title: 'Waiting',
      status: 'ready-for-agent',
      path: '.scratch/pack/issues/02.md',
      frontierBlocked: true,
      openBlockers: ['pack#09'],
    },
    {
      ref: 'pack#01',
      spec: 'pack',
      number: 1,
      title: 'Shipped',
      status: 'done',
      path: '.scratch/pack/issues/01.md',
      frontierBlocked: false,
      openBlockers: [],
    },
  ],
  specs: [{ slug: 'pack', path: '.scratch/pack/spec.md', executable: false }],
  frontier: ['pack#02', 'pack#01'],
};

const cli = `#!/usr/bin/env python3
import sys
from pathlib import Path
if "--cwd" not in sys.argv or "board" not in sys.argv:
    raise SystemExit(2)
repo = Path(sys.argv[sys.argv.index("--cwd") + 1])
sys.stdout.write((repo / ".board.json").read_text())
`;

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(cache)) return null;
  const builds = fs.readdirSync(cache).filter((name) => name.startsWith('chromium-')).sort().reverse();
  for (const build of builds) {
    const candidate = path.join(cache, build, 'chrome-linux64', 'chrome');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function initRepo(parent, name) {
  const repo = path.join(parent, name);
  fs.mkdirSync(repo, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'inherit' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Browser Operator']);
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  git(['add', 'README.md']);
  git(['commit', '-m', 'Initial commit']);
  return fs.realpathSync(repo);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

async function waitForJson(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Chrome is still opening the debugging port.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Chrome debugging endpoint did not open: ${url}`);
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let next = 0;
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('Chrome DevTools socket failed')));
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  return {
    opened,
    send(method, params = {}) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'page evaluation failed');
  }
  return result.result.value;
}

const chrome = findChrome();
if (!chrome) {
  console.error('browser-validation: no Chrome binary found. Set CHROME_PATH or install Playwright Chromium.');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-browser-board-'));
let server;
let browser;
try {
  await run(path.join(root, 'node_modules', '.bin', 'vite'), ['build']);
  const packed = initRepo(tmp, 'packed-repo');
  const empty = initRepo(tmp, 'empty-repo');
  const cliPath = path.join(packed, '.agents', 'skills', 'gantry', 'scripts', 'cli.py');
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, cli);
  const boardFile = path.join(packed, '.board.json');
  fs.writeFileSync(boardFile, JSON.stringify(board));

  const gantryHome = path.join(tmp, '.gantry');
  server = await createHarnessServer({
    gantryHome,
    stateRoot: path.join(gantryHome, 'state'),
    profileRoot: path.join(gantryHome, 'profiles'),
    port: 0,
    clientDistDir: path.join(root, 'dist', 'client'),
  });
  const pageUrl = `http://127.0.0.1:${server.port}/`;
  for (const repo of [packed, empty]) {
    const response = await fetch(`${pageUrl}api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repo }),
    });
    if (!response.ok) throw new Error(`project registration failed: ${response.status}`);
  }

  const debugPort = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
  browser = spawn(chrome, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    `--user-data-dir=${path.join(tmp, 'chrome-profile')}`,
    `--remote-debugging-port=${debugPort}`,
    pageUrl,
  ], { stdio: 'ignore' });
  await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
  const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`);
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page) throw new Error('Chrome did not open a page target');
  const session = connect(page.webSocketDebuggerUrl);
  await session.opened;
  await session.send('Runtime.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const painted = await evaluate(session, `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (document.querySelector('[data-testid="issue-card-pack#02"]')) break;
      await sleep(250);
    }
    const blocked = document.querySelector('[data-testid="issue-card-pack#02"]');
    const done = document.querySelector('[data-testid="issue-card-pack#01"]');
    const spec = document.querySelector('[data-testid="spec-card-pack"]');
    const refresh = document.querySelector('[data-testid="board-refresh"]');
    const run = document.querySelector('[data-testid="run-affordance"]');
    const boardEl = document.querySelector('[data-testid="issue-board"]');
    const blocker = blocked ? blocked.querySelector('[data-testid="open-blocker"]') : null;
    return {
      blockedPhase: blocked ? blocked.getAttribute('data-phase') : null,
      blockedText: blocked ? blocked.textContent : '',
      blocker: blocker ? blocker.textContent : '',
      doneText: done ? done.textContent : '',
      specText: spec ? spec.textContent : '',
      refreshName: refresh ? refresh.textContent : '',
      runEnabled: Boolean(run && run.disabled === false),
      boardLabel: boardEl ? boardEl.getAttribute('aria-label') : '',
      desktopWidth: boardEl ? boardEl.getBoundingClientRect().width : 0,
    };
  })()`);

  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 800,
    deviceScaleFactor: 1,
    mobile: true,
  });
  const mobile = await evaluate(session, `(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const boardEl = document.querySelector('[data-testid="issue-board"]');
    const rect = boardEl ? boardEl.getBoundingClientRect() : { width: 0, left: 9999 };
    return { width: rect.width, left: rect.left, innerWidth: window.innerWidth };
  })()`);

  const disabled = await evaluate(session, `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const empty = [...document.querySelectorAll('button')].find((entry) => entry.textContent.includes('empty-repo'));
    if (!empty) return { clicked: false, runDisabled: false, explanation: '', planDisabled: false, approveDisabled: false };
    empty.click();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const note = document.querySelector('[data-testid="execution-unavailable"]');
      const run = document.querySelector('[data-testid="run-affordance"]');
      const plan = document.querySelector('[data-testid="plan-affordance"]');
      const approve = document.querySelector('[data-testid="approve-affordance"]');
      if (note && run && run.disabled && plan && plan.disabled && approve && approve.disabled) {
        return { clicked: true, runDisabled: true, planDisabled: true, approveDisabled: true, explanation: note.textContent };
      }
      await sleep(250);
    }
    const note = document.querySelector('[data-testid="execution-unavailable"]');
    return { clicked: true, runDisabled: false, planDisabled: false, approveDisabled: false, explanation: note ? note.textContent : '' };
  })()`);

  const revised = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
  revised.issues.find((issue) => issue.ref === 'pack#01').title = 'Shipped revised';
  fs.writeFileSync(boardFile, JSON.stringify(revised));
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const refreshed = await evaluate(session, `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const packed = [...document.querySelectorAll('[data-testid="sidebar"] button')].find((entry) => entry.textContent.includes('packed-repo'));
    if (packed) packed.click();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const refresh = document.querySelector('[data-testid="board-refresh"]');
      const card = document.querySelector('[data-testid="issue-card-pack#01"]');
      if (refresh && card && card.textContent.includes('Shipped')) {
        refresh.click();
        break;
      }
      await sleep(250);
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const card = document.querySelector('[data-testid="issue-card-pack#01"]');
      if (card && card.textContent.includes('Shipped revised')) return { title: card.textContent };
      await sleep(250);
    }
    const card = document.querySelector('[data-testid="issue-card-pack#01"]');
    return { title: card ? card.textContent : '', body: document.body.innerText.slice(0, 500) };
  })()`);
  session.close();

  const ok = painted.blockedPhase === 'blocked'
    && painted.blocker === 'pack#09'
    && painted.blockedText.includes('blocked')
    && painted.doneText.includes('done')
    && painted.specText.includes('non-executable')
    && painted.refreshName.includes('Atualizar quadro')
    && painted.runEnabled
    && painted.boardLabel === 'Issues e Specs'
    && painted.desktopWidth > 200
    && mobile.width > 100
    && mobile.left < mobile.innerWidth
    && disabled.runDisabled
    && disabled.planDisabled
    && disabled.approveDisabled
    && /gantry/i.test(disabled.explanation)
    && refreshed.title.includes('Shipped revised');
  const evidence = { ok, chrome, painted, mobile, disabled, refreshed };
  if (!ok) {
    console.error(JSON.stringify(evidence, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, chrome, desktopWidth: painted.desktopWidth, mobileWidth: mobile.width }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
} finally {
  if (browser) browser.kill('SIGTERM');
  if (server) await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
