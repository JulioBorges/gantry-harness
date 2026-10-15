import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSkillDir, runCommand, runGantryScript } from './commandRunner.js';

export interface StructuredTurnBlock {
  id: string;
  type: 'tool' | 'command' | 'diff' | 'text';
  title: string;
  content: string;
  clickablePaths: string[];
  collapsed: boolean;
  createdAt: string;
}

export interface ManagedPane {
  paneId: string;
  projectId: string;
  worktreePath: string;
  launcher: 'claude' | 'codex' | 'opencode' | 'agy' | 'shell';
  command: string[];
  mode: 'chat' | 'terminal';
  activeRunId: string | null;
  terminalBuffer: string;
  turnBlocks: StructuredTurnBlock[];
  status: 'running' | 'exited';
  createdAt: string;
}

interface InternalPaneRecord extends ManagedPane {
  process?: ChildProcessWithoutNullStreams;
}

const ANSI_REGEX = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const FILE_PATH_REGEX = /\b([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|py|md|json|css|html))\b/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '').replace(/\r/g, '');
}

export function extractClickablePaths(text: string): string[] {
  const cleaned = stripAnsi(text);
  const matches = new Set<string>();
  for (const match of cleaned.matchAll(FILE_PATH_REGEX)) {
    matches.add(match[1]);
  }
  return Array.from(matches);
}

function resolveLauncherCommand(launcher: 'claude' | 'codex' | 'opencode' | 'agy' | 'shell'): string[] {
  const shellBin = process.env.SHELL || '/bin/bash';
  if (launcher === 'shell') {
    return [shellBin];
  }
  // Launch an interactive shell that invokes the requested CLI when available or stays interactive
  return [shellBin, '-c', `command -v ${launcher} >/dev/null 2>&1 && exec ${shellBin} || exec ${shellBin}`];
}

export class PtySupervisor {
  private panes = new Map<string, InternalPaneRecord>();

  private key(projectId: string, paneId: string): string {
    return `${projectId}:${paneId}`;
  }

  public async spawnPane(params: {
    projectId: string;
    paneId: string;
    worktreePath: string;
    launcher: 'claude' | 'codex' | 'opencode' | 'agy' | 'shell';
    mode?: 'chat' | 'terminal';
    broadcast: (evt: Record<string, unknown>) => void;
  }): Promise<ManagedPane> {
    const worktreePath = path.resolve(params.worktreePath);
    const skillDir = resolveSkillDir(worktreePath).skillDir;
    let activeRunId: string | null = null;
    if (skillDir && fs.existsSync(worktreePath)) {
      const curRes = await runGantryScript('runlog.py', ['current', '--cwd', worktreePath, '--json'], {
        repoRoot: worktreePath,
        skillDir,
      });
      if (curRes.exitCode === 0 && curRes.stdout.trim()) {
        try {
          activeRunId = JSON.parse(curRes.stdout).run ?? null;
        } catch {
          activeRunId = curRes.stdout.trim() || null;
        }
      }
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      GANTRY_LAUNCHER: params.launcher,
      ...(activeRunId ? { GANTRY_RUN_ID: activeRunId } : {}),
    };

    const targetCmd = resolveLauncherCommand(params.launcher);
    // Use Python's standard-library pty.spawn to allocate a real pseudo-terminal!
    const ptyArgs = [
      '-c',
      'import pty, sys; pty.spawn(sys.argv[1:])',
      ...targetCmd,
    ];

    const child = spawn('python3', ptyArgs, {
      cwd: fs.existsSync(worktreePath) ? worktreePath : process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const banner = `[${params.launcher}] PTY attached in ${worktreePath}${activeRunId ? ` (GANTRY_RUN_ID=${activeRunId})` : ''}\r\n`;
    const record: InternalPaneRecord = {
      paneId: params.paneId,
      projectId: params.projectId,
      worktreePath,
      launcher: params.launcher,
      command: targetCmd,
      mode: params.mode ?? 'terminal',
      activeRunId,
      terminalBuffer: banner,
      turnBlocks: [
        {
          id: `blk-init-${Date.now()}`,
          type: 'command',
          title: `Launch ${params.launcher}`,
          content: stripAnsi(banner).trim(),
          clickablePaths: extractClickablePaths(banner),
          collapsed: false,
          createdAt: new Date().toISOString(),
        },
      ],
      status: 'running',
      createdAt: new Date().toISOString(),
      process: child,
    };

    const onChunk = (chunk: Buffer | string): void => {
      const rawText = chunk.toString();
      const cleanText = stripAnsi(rawText).trim();
      record.terminalBuffer += rawText;
      const paths = extractClickablePaths(rawText);
      if (cleanText) {
        const blockType: StructuredTurnBlock['type'] = cleanText.includes('diff --git')
          ? 'diff'
          : cleanText.startsWith('$ ') || cleanText.startsWith('Tool:')
            ? 'tool'
            : 'text';
        record.turnBlocks.push({
          id: `blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: blockType,
          title:
            blockType === 'diff'
              ? 'File Diff'
              : blockType === 'tool'
                ? 'Tool Execution'
                : `Turn Output (${params.launcher})`,
          content: cleanText,
          clickablePaths: paths,
          collapsed: blockType === 'tool',
          createdAt: new Date().toISOString(),
        });
      }
      params.broadcast({
        type: 'pane.output',
        projectId: params.projectId,
        paneId: params.paneId,
        chunk: rawText,
        clickablePaths: paths,
      });
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('close', () => {
      record.status = 'exited';
    });

    this.panes.set(this.key(params.projectId, params.paneId), record);
    return this.toPublicPane(record);
  }

  public async writeInput(
    projectId: string,
    paneId: string,
    data: string,
    broadcast: (evt: Record<string, unknown>) => void,
  ): Promise<ManagedPane> {
    const rec = this.panes.get(this.key(projectId, paneId));
    if (!rec) {
      throw new Error(`Pane not found: ${paneId}`);
    }

    rec.terminalBuffer += data;
    const paths = extractClickablePaths(data);
    rec.turnBlocks.push({
      id: `blk-in-${Date.now()}`,
      type: 'command',
      title: `Operator Input`,
      content: stripAnsi(data).trim(),
      clickablePaths: paths,
      collapsed: true,
      createdAt: new Date().toISOString(),
    });

    if (rec.process && rec.status === 'running') {
      rec.process.stdin.write(data);
      await new Promise((r) => setTimeout(r, 100));
    }

    broadcast({
      type: 'pane.input',
      projectId,
      paneId,
      data,
    });

    return this.toPublicPane(rec);
  }

  public toggleMode(
    projectId: string,
    paneId: string,
    broadcast: (evt: Record<string, unknown>) => void,
  ): ManagedPane {
    const rec = this.panes.get(this.key(projectId, paneId));
    if (!rec) {
      throw new Error(`Pane not found: ${paneId}`);
    }
    rec.mode = rec.mode === 'terminal' ? 'chat' : 'terminal';
    const pub = this.toPublicPane(rec);
    broadcast({
      type: 'pane.mode_toggled',
      projectId,
      paneId,
      mode: rec.mode,
      pane: pub,
    });
    return pub;
  }

  public getPane(projectId: string, paneId: string): ManagedPane | null {
    const rec = this.panes.get(this.key(projectId, paneId));
    return rec ? this.toPublicPane(rec) : null;
  }

  public listPanes(projectId: string): ManagedPane[] {
    const out: ManagedPane[] = [];
    for (const rec of this.panes.values()) {
      if (rec.projectId === projectId) {
        out.push(this.toPublicPane(rec));
      }
    }
    return out;
  }

  public closeAll(): void {
    for (const rec of this.panes.values()) {
      if (rec.process && rec.status === 'running') {
        rec.process.kill('SIGTERM');
      }
    }
    this.panes.clear();
  }

  private toPublicPane(rec: InternalPaneRecord): ManagedPane {
    return {
      paneId: rec.paneId,
      projectId: rec.projectId,
      worktreePath: rec.worktreePath,
      launcher: rec.launcher,
      command: rec.command,
      mode: rec.mode,
      activeRunId: rec.activeRunId,
      terminalBuffer: rec.terminalBuffer,
      turnBlocks: rec.turnBlocks,
      status: rec.status,
      createdAt: rec.createdAt,
    };
  }
}

export async function readArtifactAndDiff(
  repoRoot: string,
  relPath: string,
  includeDiff: boolean,
): Promise<{ path: string; content: string; diff: string }> {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, relPath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error('Artifact path escapes repository root');
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Artifact not found: ${relPath}`);
  }
  const content = fs.readFileSync(resolved, 'utf-8');
  let diff = '';
  if (includeDiff) {
    const diffRes = await runCommand(['git', 'diff', 'HEAD', '--', relPath], { cwd: root });
    diff = diffRes.stdout;
  }
  return {
    path: relPath,
    content,
    diff,
  };
}
