import { getTerminalEnvironment } from './terminalSettings.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { HarnessStateStore } from './stateStore.js';
import { resolveSkillDir, runGantryScript } from './commandRunner.js';
import {
  applyRepositorySetup,
  bootstrapProjectSkills,
  discoverHarnessModels,
  inspectProject,
  previewRepositorySetup,
  resolveProjectRoles,
} from './projectInspector.js';
import { PtySupervisor, readArtifactAndDiff } from './ptyManager.js';
import { ProjectTreeError, readProjectTree } from './projectTree.js';

export interface HarnessServerOptions {
  gantryHome?: string;
  stateRoot?: string;
  profileRoot?: string;
  host?: string;
  port?: number;
  requirePairingForRemote?: boolean;
  clientDistDir?: string;
}

export interface HarnessServerInstance {
  host: string;
  port: number;
  gantryHome: string;
  stateRoot: string;
  profileRoot: string;
  store: HarnessStateStore;
  broadcast: (event: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

export async function resolveUnitId(repoPath: string, skillDir?: string | null): Promise<string> {
  const effectiveSkill = skillDir ?? resolveSkillDir(repoPath).skillDir;
  if (effectiveSkill) {
    try {
      const res = await runGantryScript('runlog.py', ['unit-id', '--cwd', repoPath, '--json'], {
        repoRoot: repoPath,
        skillDir: effectiveSkill,
      });
      if (res.exitCode === 0) {
        const parsed = JSON.parse(res.stdout);
        if (parsed.unitId && /^[0-9a-f]{12}$/.test(parsed.unitId)) {
          return parsed.unitId;
        }
      }
    } catch {
      // fallback below
    }
  }
  return crypto.createHash('sha256').update(fs.realpathSync(repoPath)).digest('hex').slice(0, 12);
}

export async function createHarnessServer(
  options: HarnessServerOptions = {},
): Promise<HarnessServerInstance> {
  const gantryHome = path.resolve(options.gantryHome ?? path.join(os.homedir(), '.gantry'));
  const stateRoot = path.resolve(options.stateRoot ?? path.join(gantryHome, 'state'));
  const profileRoot = path.resolve(options.profileRoot ?? path.join(gantryHome, 'profiles'));
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 7400;
  const clientDistDir = path.resolve(options.clientDistDir ?? fileURLToPath(new NodeURL('../client/', import.meta.url)));

  fs.mkdirSync(gantryHome, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(profileRoot, { recursive: true });

  const store = new HarnessStateStore(gantryHome);
  const ptySupervisor = new PtySupervisor();
  const lockPath = path.join(store.harnessDir, 'server.lock');

  const clients = new Set<WebSocket>();
  const broadcast = (payload: Record<string, unknown>): void => {
    const serialized = JSON.stringify(payload);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(serialized);
      }
    }
  };

  const readJsonBody = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
    return new Promise((resolve, reject) => {
      let body = '';
      req.setEncoding('utf-8');
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        if (!body.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(body) as Record<string, unknown>);
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  };

  const sendJson = (res: http.ServerResponse, statusCode: number, data: unknown): void => {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Forwarded-For',
    });
    res.end(JSON.stringify(data));
  };

  const isRemoteRequest = (req: http.IncomingMessage): boolean => {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim() !== '' && forwarded.trim() !== '127.0.0.1') {
      return true;
    }
    const remoteAddr = req.socket.remoteAddress ?? '127.0.0.1';
    return remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1';
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        sendJson(res, 204, {});
        return;
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const pathname = url.pathname;

      if (pathname === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, { status: 'ok', pid: process.pid, gantryHome });
        return;
      }

      if ((pathname === '/' || pathname === '/index.html') && req.method === 'GET') {
        const distHtml = path.join(clientDistDir, 'index.html');
        const rootHtml = path.resolve(process.cwd(), 'index.html');
        const htmlContent = fs.existsSync(distHtml)
          ? fs.readFileSync(distHtml, 'utf-8')
          : fs.existsSync(rootHtml)
            ? fs.readFileSync(rootHtml, 'utf-8')
            : `<!doctype html><html><head><title>gantry-harness</title></head><body><div id="root">gantry-harness</div></body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlContent);
        return;
      }

      if (pathname.startsWith('/assets/') && req.method === 'GET') {
        const distClientDir = clientDistDir;
        const assetPath = path.resolve(distClientDir, pathname.slice(1));
        if (
          assetPath.startsWith(distClientDir + path.sep) &&
          fs.existsSync(assetPath) &&
          fs.statSync(assetPath).isFile()
        ) {
          const ext = path.extname(assetPath).toLowerCase();
          const mime =
            ext === '.js'
              ? 'application/javascript; charset=utf-8'
              : ext === '.css'
                ? 'text/css; charset=utf-8'
                : 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': mime });
          res.end(fs.readFileSync(assetPath));
          return;
        }
      }

      if (pathname === '/api/auth/pair/verify' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const code = String(body.code ?? '');
        const token = store.verifyPairingCode(code);
        if (!token) {
          sendJson(res, 401, { error: 'Invalid or expired one-time pairing code' });
          return;
        }
        sendJson(res, 200, { token });
        return;
      }

      if (options.requirePairingForRemote && isRemoteRequest(req)) {
        const authHeader = req.headers.authorization ?? '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        if (!token || !store.isValidAuthToken(token)) {
          sendJson(res, 401, { error: 'Remote access requires a valid paired bearer token' });
          return;
        }
      }

      if (pathname === '/api/auth/pair/generate' && req.method === 'POST') {
        const code = store.generatePairingCode();
        sendJson(res, 200, { code });
        return;
      }

      if (pathname === '/api/workspace/state' && req.method === 'GET') {
        const projects = store.listProjects();
        const layout = store.getWorkspaceLayout();
        sendJson(res, 200, {
          projects,
          layout,
          terminalSettings: store.getTerminalSettings(),
          terminalEnvironment: getTerminalEnvironment(),
        });
        return;
      }

      if (pathname === '/api/workspace/state' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        const updated = store.saveWorkspaceLayout(body);
        broadcast({ type: 'workspace.layout.updated', layout: updated });
        sendJson(res, 200, { layout: updated });
        return;
      }

      if (pathname === '/api/projects' && req.method === 'GET') {
        sendJson(res, 200, { projects: store.listProjects() });
        return;
      }

      if (pathname === '/api/projects' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const inputPath = String(body.path ?? '');
        const expandedPath = inputPath === '~' || inputPath.startsWith('~/')
          ? path.join(os.homedir(), inputPath.slice(2))
          : inputPath;
        const repoPath = path.resolve(expandedPath);
        if (!fs.existsSync(repoPath)) {
          sendJson(res, 400, { error: `Directory does not exist: ${repoPath}` });
          return;
        }
        const unitId = await resolveUnitId(repoPath);
        const result = store.upsertProject({
          path: repoPath,
          name: body.name ? String(body.name) : undefined,
          unitId,
        });
        const inspection = await inspectProject(result.project, { stateRoot, profileRoot });
        broadcast({ type: 'project.registered', project: result.project, inspection });
        sendJson(res, 200, { ...result, inspection });
        return;
      }

      if (pathname.startsWith('/api/projects/') && req.method === 'DELETE') {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length === 3) {
          const projectId = parts[2];
          const removed = store.removeProject(projectId);
          broadcast({ type: 'project.removed', projectId });
          sendJson(res, 200, { removed });
          return;
        }
      }

      if (pathname === '/api/alerts' && req.method === 'GET') {
        sendJson(res, 200, { alerts: store.listPendingAlerts() });
        return;
      }

      if (pathname.startsWith('/api/projects/') && pathname.endsWith('/inspect') && req.method === 'GET') {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length === 4) {
          const projectId = parts[2];
          const project = store.getProject(projectId);
          if (!project) {
            sendJson(res, 404, { error: `Project not found: ${projectId}` });
            return;
          }
          const inspection = await inspectProject(project, { stateRoot, profileRoot });
          sendJson(res, 200, inspection);
          return;
        }
      }

      if (pathname.startsWith('/api/projects/') && pathname.endsWith('/tree') && req.method === 'GET') {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length === 4) {
          const project = store.getProject(parts[2]);
          if (!project) {
            sendJson(res, 404, { error: 'Projeto não encontrado.' });
            return;
          }
          try {
            sendJson(res, 200, readProjectTree(project.path, {
              path: url.searchParams.get('path') ?? '',
              query: url.searchParams.get('query') ?? '',
            }));
          } catch (error) {
            if (error instanceof ProjectTreeError) {
              sendJson(res, error.status, { error: error.message });
              return;
            }
            throw error;
          }
          return;
        }
      }

      if (pathname.startsWith('/api/projects/') && pathname.endsWith('/bootstrap') && req.method === 'POST') {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length === 4) {
          const projectId = parts[2];
          const project = store.getProject(projectId);
          if (!project) {
            sendJson(res, 404, { error: `Project not found: ${projectId}` });
            return;
          }
          const boot = await bootstrapProjectSkills(project.path);
          broadcast({ type: 'project.bootstrapped', projectId, ...boot });
          sendJson(res, 200, boot);
          return;
        }
      }

      if (pathname.startsWith('/api/projects/') && pathname.endsWith('/discovery') && req.method === 'GET') {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length === 4) {
          const projectId = parts[2];
          const project = store.getProject(projectId);
          if (!project) {
            sendJson(res, 404, { error: `Project not found: ${projectId}` });
            return;
          }
          const harness = url.searchParams.get('harness') ?? 'opencode';
          const catalog = await discoverHarnessModels(project.path, harness);
          sendJson(res, 200, catalog);
          return;
        }
      }

      if (pathname.startsWith('/api/projects/') && pathname.endsWith('/roles') && req.method === 'GET') {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length === 4) {
          const projectId = parts[2];
          const project = store.getProject(projectId);
          if (!project) {
            sendJson(res, 404, { error: `Project not found: ${projectId}` });
            return;
          }
          const resolved = await resolveProjectRoles(project.path, profileRoot);
          sendJson(res, 200, resolved);
          return;
        }
      }

      if (pathname.startsWith('/api/projects/') && pathname.endsWith('/setup/preview') && req.method === 'POST') {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length === 5) {
          const projectId = parts[2];
          const project = store.getProject(projectId);
          if (!project) {
            sendJson(res, 404, { error: `Project not found: ${projectId}` });
            return;
          }
          const body = await readJsonBody(req);
          const preview = await previewRepositorySetup(
            project.path,
            (body.policy as Record<string, unknown>) ?? {},
            profileRoot,
            (body.mode as 'overwrite' | 'merge') ?? 'overwrite',
          );
          sendJson(res, 200, preview);
          return;
        }
      }

      if (pathname.startsWith('/api/projects/') && pathname.endsWith('/setup/apply') && req.method === 'POST') {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length === 5) {
          const projectId = parts[2];
          const project = store.getProject(projectId);
          if (!project) {
            sendJson(res, 404, { error: `Project not found: ${projectId}` });
            return;
          }
          const body = await readJsonBody(req);
          const result = await applyRepositorySetup(
            project.path,
            {
              scope: (body.scope as 'repository' | 'personal') ?? 'repository',
              policy: body.policy as Record<string, unknown> | undefined,
              mode: body.mode as 'overwrite' | 'merge' | undefined,
              hostHarness: body.hostHarness as string | undefined,
              roles: body.roles as Record<string, unknown> | undefined,
            },
            profileRoot,
          );
          broadcast({ type: 'project.setup.applied', projectId, scope: body.scope });
          sendJson(res, 200, result);
          return;
        }
      }

      if (pathname.startsWith('/api/projects/') && pathname.endsWith('/panes')) {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length === 4) {
          const projectId = parts[2];
          const project = store.getProject(projectId);
          if (!project) {
            sendJson(res, 404, { error: `Project not found: ${projectId}` });
            return;
          }
          if (req.method === 'GET') {
            sendJson(res, 200, { panes: ptySupervisor.listPanes(projectId) });
            return;
          }
          if (req.method === 'POST') {
            const body = await readJsonBody(req);
            const pane = await ptySupervisor.spawnPane({
              projectId,
              paneId: String(body.paneId ?? `pane-${Date.now()}`),
              worktreePath: String(body.worktreePath ?? project.path),
              launcher:
                (body.launcher as 'claude' | 'codex' | 'opencode' | 'agy' | 'shell') ?? 'shell',
              mode: 'terminal',
              shell: store.getTerminalSettings().shell,
              broadcast,
            });
            sendJson(res, 200, { pane });
            return;
          }
        }
      }

      if (pathname.startsWith('/api/projects/') && pathname.includes('/panes/')) {
        const parts = pathname.split('/').filter(Boolean);
        // /api/projects/:id/panes/:paneId[/input|/toggle]
        const projectId = parts[2];
        const paneId = parts[4];
        const subAction = parts[5];

        if (!subAction && req.method === 'DELETE') {
          ptySupervisor.closePane(projectId, paneId);
          broadcast({ type: 'pane.closed', projectId, paneId });
          sendJson(res, 200, { ok: true });
          return;
        }

        if (subAction === 'resize' && req.method === 'POST') {
          const body = await readJsonBody(req);
          sendJson(res, 200, { pane: ptySupervisor.resizePane(projectId, paneId, Number(body.cols), Number(body.rows)) });
          return;
        }

        if (!subAction && req.method === 'GET') {
          const pane = ptySupervisor.getPane(projectId, paneId);
          if (!pane) {
            sendJson(res, 404, { error: `Pane not found: ${paneId}` });
            return;
          }
          sendJson(res, 200, { pane });
          return;
        }

        if (subAction === 'input' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const pane = await ptySupervisor.writeInput(
            projectId,
            paneId,
            String(body.data ?? ''),
            broadcast,
          );
          sendJson(res, 200, { ok: true, pane });
          return;
        }

      }

      if (pathname.startsWith('/api/projects/') && pathname.endsWith('/artifact-assets') && req.method === 'GET') {
        const project = store.getProject(pathname.split('/')[3]);
        if (!project) { sendJson(res, 404, { error: 'Projeto não encontrado.' }); return; }
        const root = fs.realpathSync(project.path);
        const filename = path.resolve(root, url.searchParams.get('path') ?? '');
        const resolved = fs.existsSync(filename) ? fs.realpathSync(filename) : filename;
        if (!resolved.startsWith(root + path.sep)) { sendJson(res, 403, { error: 'A imagem deve estar dentro do projeto.' }); return; }
        const mimeTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml' };
        const mime = mimeTypes[path.extname(resolved).toLowerCase()];
        if (!mime) { sendJson(res, 415, { error: 'Formato de imagem não suportado.' }); return; }
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) { sendJson(res, 404, { error: 'Imagem não encontrada.' }); return; }
        if (fs.statSync(resolved).size > 20 * 1024 * 1024) { sendJson(res, 413, { error: 'A imagem excede 20 MB.' }); return; }
        res.writeHead(200, { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
        res.end(fs.readFileSync(resolved));
        return;
      }

      if (pathname.startsWith('/api/projects/') && pathname.endsWith('/artifacts')) {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length === 4) {
          const projectId = parts[2];
          const project = store.getProject(projectId);
          if (!project) {
            sendJson(res, 404, { error: `Project not found: ${projectId}` });
            return;
          }
          if (req.method === 'GET') {
            const relPath = url.searchParams.get('path') ?? '';
            const includeDiff = url.searchParams.get('diff') === 'true';
            const art = await readArtifactAndDiff(project.path, relPath, includeDiff);
            sendJson(res, 200, art);
            return;
          }
          if (req.method === 'PUT') {
            const body = await readJsonBody(req);
            const relPath = String(body.path ?? '');
            const root = path.resolve(project.path);
            const resolved = path.resolve(root, relPath);
            if (!resolved.startsWith(root + path.sep)) {
              sendJson(res, 400, { error: 'Invalid artifact path' });
              return;
            }
            fs.writeFileSync(resolved, String(body.content ?? ''), 'utf-8');
            sendJson(res, 200, { saved: true, path: relPath });
            return;
          }
        }
      }

      if (pathname === '/api/settings/terminal' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        try {
          const settings = store.updateTerminalSettings(body);
          sendJson(res, 200, { settings, environment: getTerminalEnvironment() });
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : 'Configurações de terminal inválidas.' });
        }
        return;
      }

      if (pathname === '/api/cli/dispatch' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const cwd = path.resolve(String(body.cwd ?? process.cwd()));
        const subcommand = body.subcommand ? String(body.subcommand) : undefined;
        const argument = body.argument ? String(body.argument) : undefined;

        const unitId = await resolveUnitId(cwd);
        const { project } = store.upsertProject({ path: cwd, unitId });
        const layout = store.saveWorkspaceLayout({
          activeProjectId: project.id,
        });

        broadcast({
          type: 'cli.dispatched',
          project,
          layout,
          subcommand,
          argument,
        });

        sendJson(res, 200, {
          focusedProjectPath: project.path,
          projectId: project.id,
          triggeredCommand: subcommand ? { subcommand, argument } : null,
        });
        return;
      }

      sendJson(res, 404, { error: `Not found: ${pathname}` });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : 'Internal server error',
      });
    }
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    if (options.requirePairingForRemote && isRemoteRequest(req)) {
      const wsUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const queryToken = wsUrl.searchParams.get('token') ?? '';
      const authHeader = req.headers.authorization ?? '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const token = queryToken || bearerToken;
      if (!token || !store.isValidAuthToken(token)) {
        ws.close(1008, 'Unauthorized remote WebSocket connection');
        return;
      }
    }
    clients.add(ws);
    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort;

  fs.writeFileSync(
    lockPath,
    JSON.stringify(
      {
        pid: process.pid,
        host,
        port: actualPort,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf-8',
  );

  return {
    host,
    port: actualPort,
    gantryHome,
    stateRoot,
    profileRoot,
    store,
    broadcast,
    close: async () => {
      ptySupervisor.closeAll();
      for (const ws of clients) {
        ws.close();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => {
          server.close(() => resolve());
        });
      });
      store.close();
      if (fs.existsSync(lockPath)) {
        try {
          const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
          if (lock.port === actualPort) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          // ignore cleanup race
        }
      }
    },
  };
}
