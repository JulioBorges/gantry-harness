import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createHarnessServer } from '../src/server/app.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-browser-board-'));
const evidenceDir = process.env.BROWSER_EVIDENCE_DIR
  ? path.resolve(process.env.BROWSER_EVIDENCE_DIR)
  : path.join(tmp, 'evidence');
const board = {
  issues: [
    { ref: 'pack#02', spec: 'pack', number: 2, title: 'Waiting', status: 'ready-for-agent', path: '.scratch/pack/issues/02.md', frontierBlocked: true, openBlockers: ['pack#09'] },
    { ref: 'pack#01', spec: 'pack', number: 1, title: 'Shipped', status: 'done', path: '.scratch/pack/issues/01.md', frontierBlocked: false, openBlockers: [] },
  ],
  specs: [{ slug: 'pack', path: '.scratch/pack/spec.md', executable: false }],
  frontier: ['pack#02'],
};
const cli = `import sys
from pathlib import Path
if '--cwd' not in sys.argv or 'board' not in sys.argv:
    raise SystemExit(2)
repo = Path(sys.argv[sys.argv.index('--cwd') + 1])
sys.stdout.write((repo / '.board.json').read_text())
`;
function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
}
function initRepo(name) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Browser Operator');
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'Initial commit');
  return fs.realpathSync(repo);
}
let server;
let browser;
try {
  fs.mkdirSync(evidenceDir, { recursive: true });
  execFileSync(path.join(root, 'node_modules/.bin/vite'), ['build'], { cwd: root, stdio: 'inherit' });
  process.env.HOME = fs.mkdtempSync(path.join(tmp, 'git-home-'));
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const packedName = 'packed-repo-com-nome-muito-longo-para-identificar-o-projeto';
  const packed = initRepo(packedName);
  const cliPath = path.join(packed, '.agents/skills/gantry/scripts/cli.py');
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, cli);
  const boardFile = path.join(packed, '.board.json');
  fs.writeFileSync(boardFile, JSON.stringify(board));
  fs.mkdirSync(path.join(packed, '.gantry'), { recursive: true });
  fs.writeFileSync(path.join(packed, '.gantry/config.json'), JSON.stringify({ execution: {
    hostHarness: 'codex',
    roles: Object.fromEntries(['plan', 'implement', 'review', 'critic'].map(role => [role, { harness: 'codex', model: 'google/gemini-4-argon-modelo-com-nome-longo', effort: 'high' }])),
  } }));
  const gantryHome = path.join(tmp, '.gantry');
  server = await createHarnessServer({ gantryHome, stateRoot: path.join(gantryHome, 'state'), profileRoot: path.join(gantryHome, 'profiles'), homeDir: tmp, port: 0, clientDistDir: path.join(root, 'dist/client') });
  const url = `http://127.0.0.1:${server.port}/`;
  const projects = [];
  for (const repo of [packed, ...Array.from({ length: 9 }, (_, i) => initRepo(`empty-repo-${i}-nome-longo-para-rolagem`))]) {
    const res = await fetch(`${url}api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${server.port}` }, body: JSON.stringify({ path: repo }) });
    if (!res.ok) throw new Error(`project registration failed: ${res.status}`);
    projects.push((await res.json()).project);
  }
  for (let i = 3; i < 12; i++) {
    const worktree = path.join(tmp, `worktree-${i}`);
    git(packed, 'worktree', 'add', '-b', `gantry/pack-${i}`, worktree);
    const now = new Date().toISOString();
    server.store.saveRun({ runId: `browser-run-${i}`, projectId: projects[0].id, ref: `pack#${String(i).padStart(2, '0')}`, slug: 'pack', kind: 'issue', status: 'stopped', childPid: null, pid: null, childHandle: null, lane: 'implement', packPhase: 'implement', branch: `gantry/pack-${i}`, worktree, pushed: false, pause: null, pausedReason: null, pausedChoices: null, terminalEvent: 'stopped', error: null, prUrl: null, derivedPhase: 'stopped', createdAt: now, updatedAt: now });
  }
  git(packed, 'worktree', 'add', '-b', 'unrelated', path.join(tmp, 'unrelated'));
  browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ['--no-sandbox'] });
  const results = [];
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Keep layout validation independent of installed model CLIs, including an unknown saved model.
    await page.route('**/api/projects/*/discovery?*', route => route.fulfill({ json: { models: [{ id: 'codex-test-model' }] } }));
    await page.goto(url);
    const sidebar = page.getByTestId('sidebar');
    const openNavigation = async () => {
      if (!await sidebar.isVisible()) await page.getByRole('button', { name: 'Alternar navegação' }).click();
    };
    await openNavigation();
    await sidebar.getByRole('button', { name: packedName, exact: false }).first().click();
    await expect(page.getByTestId('issue-card-pack#02')).toHaveAttribute('data-phase', 'blocked');
    await expect(page.getByTestId('open-blocker')).toHaveText('pack#09');
    await expect(page.getByTestId('lane-done').getByTestId('issue-card-pack#01')).toContainText('Shipped');
    await expect(page.getByTestId('spec-card-pack')).toContainText('non-executable');
    await expect(page.getByTestId('run-affordance')).toBeEnabled();
    await openNavigation();
    await sidebar.getByText('Worktrees', { exact: true }).click();
    await expect(sidebar.locator('.worktree-row')).not.toHaveCount(0);
    await page.screenshot({ path: path.join(evidenceDir, `sidebar-${viewport.width}.png`) });
    const selected = sidebar.locator('.project-row.selected');
    await expect(selected.locator('strong')).toHaveText(packedName);
    const dimensions = await selected.locator('strong').evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
    expect(dimensions.width).toBeGreaterThan(80);
    expect(dimensions.height).toBeGreaterThan(0);
    await expect(selected.locator('.project-path')).toHaveText(packed);
    await sidebar.getByText('Caminho completo', { exact: true }).first().click();
    await expect(sidebar.locator('.project-full-path').first()).toBeVisible();
    await expect(sidebar.locator('.project-full-path').first()).toHaveText(packed);
    await expect(sidebar.locator('.worktree-row')).toHaveCount(9);
    await expect(sidebar.locator('.worktree-row').first()).toContainText('pack#03');
    await expect(sidebar.locator('.worktree-row').filter({ hasText: 'unrelated' })).toHaveCount(0);
    await expect(sidebar.getByRole('button', { name: /assumir/i })).toHaveCount(0);
    expect(await sidebar.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await sidebar.getByTestId(`project-settings-${projects[0].id}`).click();
    await expect(page.getByRole('heading', { name: `Configurações de ${packedName}`, exact: true })).toBeVisible();
    const originalViewport = page.viewportSize();
    const modalChecks = [];
    for (const modalViewport of viewport.width === 1280 ? [{ width: 951, height: 785 }, { width: 844, height: 390 }] : [viewport]) {
      await page.setViewportSize(modalViewport);
      const dialog = page.getByRole('dialog', { name: `Configurações de ${packedName}`, exact: true });
      const panel = page.getByTestId('setup-panel');
      await expect(panel.getByLabel('Esforço para critic')).toHaveValue('high');
      await page.screenshot({ path: path.join(evidenceDir, `project-settings-${modalViewport.width}.png`) });
      const scroll = await panel.evaluate(el => ({ height: el.clientHeight, contentHeight: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
      expect(scroll.height, 'Project settings must constrain its scrolling body').toBeLessThan(scroll.contentHeight);
      expect(['auto', 'scroll']).toContain(scroll.overflow);
      modalChecks.push({ viewport: modalViewport, scroll });
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      for (const role of ['plan', 'implement', 'review', 'critic']) {
        for (const field of ['Host', 'Modelo', 'Esforço']) {
          const control = panel.getByLabel(`${field} para ${role}`, { exact: true });
          await control.scrollIntoViewIfNeeded();
          await expect(control).toBeInViewport({ ratio: 1 });
          const labelPosition = await control.evaluate(el => {
            const text = Array.from(el.parentElement.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
            const range = document.createRange();
            range.selectNodeContents(text);
            return { labelBottom: range.getBoundingClientRect().bottom, fieldTop: el.getBoundingClientRect().top };
          });
          expect(labelPosition.labelBottom).toBeLessThanOrEqual(labelPosition.fieldTop);
        }
      }
      const effort = panel.getByLabel('Esforço para critic');
      await effort.fill('medium');
      await expect(effort).toHaveValue('medium');
      await effort.fill('high');
      const save = page.getByTestId('apply-personal-setup-btn');
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole('button', { name: 'Fechar configurações do projeto' })).toBeInViewport({ ratio: 1 });
      expect(await panel.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      await page.screenshot({ path: path.join(evidenceDir, `project-settings-actions-${modalViewport.width}.png`) });
    }
    await page.setViewportSize(originalViewport);
    await page.getByRole('button', { name: 'Fechar configurações do projeto' }).click();
    await openNavigation();
    await page.getByTestId('open-settings-btn').click();
    await page.getByRole('tab', { name: 'Gantry', exact: true }).click();
    const globalPanel = page.getByTestId('global-gantry-panel');
    await globalPanel.getByLabel('Host global', { exact: true }).selectOption('codex');
    const configureRoles = globalPanel.getByRole('button', { name: 'Configurar papéis globais' });
    if (await configureRoles.count()) await configureRoles.click();
    for (const role of ['plan', 'implement', 'review', 'critic']) {
      for (const field of ['Host', 'Modelo']) {
        const control = globalPanel.getByLabel(`${field} global para ${role}`, { exact: true });
        await control.scrollIntoViewIfNeeded();
        await expect(control).toBeInViewport({ ratio: 1 });
        const bounds = await control.evaluate(el => {
          const text = Array.from(el.parentElement.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
          const range = document.createRange();
          range.selectNodeContents(text);
          return { labelBottom: range.getBoundingClientRect().bottom, fieldTop: el.getBoundingClientRect().top };
        });
        expect(bounds.labelBottom).toBeLessThanOrEqual(bounds.fieldTop);
      }
    }
    const globalDialog = page.getByRole('dialog', { name: 'Configurações', exact: true });
    expect(await globalDialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.getByTestId('save-global-execution').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('save-global-execution')).toBeInViewport({ ratio: 1 });
    await expect(globalDialog.getByRole('button', { name: 'Fechar configurações', exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: path.join(evidenceDir, `global-settings-${viewport.width}.png`) });
    await page.getByRole('button', { name: 'Fechar configurações', exact: true }).click();
    await openNavigation();
    await sidebar.getByTestId(`project-settings-${projects[0].id}`).click();

    await page.getByRole('button', { name: 'Fechar configurações do projeto' }).click();
    await openNavigation();
    // Reach the last project through the scrolling list, then open settings directly for an inactive project.
    const lastProject = projects.at(-1);
    // Exercise cleanup only in a disposable empty project, never in the pack fixture or developer checkout.
    const cleanupHead = git(lastProject.path, 'rev-parse', 'HEAD');
    const priorStashes = git(lastProject.path, 'stash', 'list');
    fs.writeFileSync(path.join(lastProject.path, 'README.md'), 'Browser cleanup changes\n');
    fs.writeFileSync(path.join(lastProject.path, 'new-notes.txt'), 'New notes\n');

    await sidebar.getByTestId(`project-settings-${lastProject.id}`).click();
    await expect(page.getByRole('heading', { name: `Configurações de ${lastProject.name}`, exact: true })).toBeVisible();
    await expect(page.getByTestId('setup-panel')).toBeVisible();
    await page.getByRole('button', { name: 'Limpar worktree', exact: true }).click();
    const cleanupReview = page.getByRole('region', { name: 'Revisar limpeza da worktree' });
    await expect(cleanupReview).toContainText(lastProject.path);
    await expect(cleanupReview).toContainText('README.md');
    await expect(cleanupReview).toContainText('new-notes.txt');
    await cleanupReview.getByRole('button', { name: 'Cancelar limpeza' }).click();
    expect(git(lastProject.path, 'stash', 'list')).toBe(priorStashes);
    expect(fs.readFileSync(path.join(lastProject.path, 'README.md'), 'utf8')).toBe('Browser cleanup changes\n');
    await page.getByRole('button', { name: 'Limpar worktree', exact: true }).click();
    await expect(cleanupReview).toBeVisible();
    await page.screenshot({ path: path.join(evidenceDir, `cleanup-preview-${viewport.width}.png`) });
    const observer = await browser.newPage({ viewport });
    await observer.goto(url);
    const observerSidebar = observer.getByTestId('sidebar');
    if (!await observerSidebar.isVisible()) await observer.getByRole('button', { name: 'Alternar navegação' }).click();
    await observerSidebar.getByTestId(`project-settings-${lastProject.id}`).click();
    await expect(observer.getByRole('button', { name: 'Limpar worktree', exact: true })).toBeVisible();
    await cleanupReview.getByRole('button', { name: 'Guardar backup e limpar worktree' }).click();
    await expect(page.getByTestId('setup-panel')).toContainText('Worktree limpa. As alterações foram guardadas no Git stash.');
    expect(git(lastProject.path, 'status', '--porcelain')).toBe('');
    expect(git(lastProject.path, 'rev-parse', 'HEAD')).toBe(cleanupHead);
    expect(git(lastProject.path, 'stash', 'list')).toContain('gantry-harness-cleanup-');
    await expect(page.getByRole('button', { name: 'Limpar worktree', exact: true })).toHaveCount(0);
    await expect(observer.getByRole('button', { name: 'Limpar worktree', exact: true })).toHaveCount(0);
    await observer.close();
    await page.screenshot({ path: path.join(evidenceDir, `cleanup-result-${viewport.width}.png`) });

    await page.getByRole('button', { name: 'Fechar configurações do projeto' }).click();
    await openNavigation();
    await sidebar.getByTestId(`project-settings-${lastProject.id}`).click();
    const bootstrapDialog = page.getByRole('dialog', { name: `Configurações de ${lastProject.name}`, exact: true });
    await bootstrapDialog.getByTestId('bootstrap-skills-btn').click();
    await expect(bootstrapDialog.getByRole('alert')).toBeVisible();
    await expect(bootstrapDialog.getByRole('alert')).toContainText('Global Gantry skill pack not found');
    await page.screenshot({ path: path.join(evidenceDir, `bootstrap-error-${viewport.width}.png`) });
    await bootstrapDialog.getByRole('button', { name: 'Fechar configurações do projeto' }).click();
    await page.locator('.action-feedback.error').getByRole('button', { name: 'Fechar aviso' }).click({ force: true });
    await expect(page.getByTestId('pack-missing')).toContainText('Gantry');
    for (const action of ['run', 'plan', 'approve']) await expect(page.getByTestId(`${action}-affordance`)).toBeDisabled();
    await openNavigation();
    await expect(sidebar.locator('[aria-current="page"]')).toContainText(lastProject.name);
    await sidebar.getByRole('button', { name: packedName, exact: false }).first().click();
    await expect(page.getByTestId('issue-card-pack#01')).toBeAttached();
    board.issues[1].title = `Shipped revised ${viewport.width}`;
    fs.writeFileSync(boardFile, JSON.stringify(board));
    if (viewport.width < 760 && await sidebar.isVisible()) await page.getByRole('button', { name: 'Fechar navegação', exact: true }).click();
    await page.getByTestId('board-refresh').click();
    await expect(page.getByTestId('issue-card-pack#01')).toContainText(board.issues[1].title);
    await page.screenshot({ path: path.join(evidenceDir, `board-${viewport.width}.png`) });
    // Drive Run snapshots through the HTTP board seam to exercise real layout after lane changes.
    let runSnapshot = { ...server.store.getRun(projects[0].id, 'pack#03'), ref: 'pack#02', runId: 'visibility-run', status: 'running', derivedPhase: 'implement', lane: 'implement', error: null };
    await page.route('**/api/projects/*/board', async route => {
      const response = await route.fetch();
      const payload = await response.json();
      await route.fulfill({ response, json: { ...payload, runs: [...(payload.runs ?? []), runSnapshot] } });
    });
    const card = page.getByTestId('issue-card-pack#02');
    await page.getByTestId('board-refresh').click();
    await expect(card).toHaveAttribute('data-lane', 'implement');
    await expect(card).toBeInViewport({ ratio: 0.8 });
    runSnapshot = { ...runSnapshot, status: 'ready-for-approval', derivedPhase: 'ready-for-approval', lane: 'critic' };
    await page.getByTestId('board-refresh').click();
    await expect(card).toHaveAttribute('data-lane', 'issues');
    await expect(card).toBeInViewport({ ratio: 0.8 });
    await expect(card.getByRole('button', { name: 'Aprovar', exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(evidenceDir, `ready-run-${viewport.width}.png`) });
    runSnapshot = { ...runSnapshot, status: 'approved-pending-merge', derivedPhase: 'approved-pending-merge', prUrl: 'https://example.test/pr/42' };
    await page.getByTestId('board-refresh').click();
    await expect(card).toHaveAttribute('data-lane', 'issues');
    await expect(card.getByRole('link')).toHaveAttribute('href', runSnapshot.prUrl);
    board.issues[0].status = 'done';
    fs.writeFileSync(boardFile, JSON.stringify(board));
    await page.getByTestId('board-refresh').click();
    await expect(card).toHaveAttribute('data-lane', 'done');
    await expect(card).toBeInViewport({ ratio: 0.8 });
    board.issues[0].status = 'ready-for-agent';
    fs.writeFileSync(boardFile, JSON.stringify(board));
    for (const status of ['stopped', 'failed']) {
      runSnapshot = { ...runSnapshot, status, derivedPhase: status };
      await page.getByTestId('board-refresh').click();
      await expect(card).toHaveAttribute('data-phase', status);
      await expect(card).toHaveAttribute('data-lane', 'issues');
      await expect(card).toBeInViewport({ ratio: 0.8 });
    }
    runSnapshot = { ...runSnapshot, kind: 'plan', slug: 'new-plan', ref: 'new-plan', worktree: null, prUrl: null, error: { code: 'setup-invalid', reason: 'role-command-missing' } };
    await page.getByTestId('board-refresh').click();
    const planCard = page.getByTestId('issue-card-new-plan#01');
    await expect(planCard).toContainText('Run de planejamento');
    await expect(planCard).toHaveAttribute('data-phase', 'failed');
    await expect(planCard.getByRole('button', { name: 'Executar issue' })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(1);
    expect(errors).toEqual([]);
    results.push({ viewport, dimensions, projectSettings: modalChecks, pageErrors: errors });
    await page.close();
  }
  fs.writeFileSync(path.join(evidenceDir, 'project-settings-results.json'), JSON.stringify(results.flatMap(result => result.projectSettings), null, 2));
  fs.writeFileSync(path.join(evidenceDir, 'results.json'), JSON.stringify({ ok: true, results }, null, 2));
  console.log(JSON.stringify({ ok: true, results }));
} finally {
  await browser?.close();
  await server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
