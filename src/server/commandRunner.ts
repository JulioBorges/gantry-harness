import { spawn } from 'cross-spawn';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function findExecutable(binary: string): string | null {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const extensions = process.platform === 'win32' ? (path.extname(binary) ? [''] : (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')) : [''];
    for (const extension of extensions) {
    const candidate = path.join(directory, binary + extension);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* Try the next PATH entry. */ }
    }
  }
  return null;
}

export interface RunCommandOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  /** When false, `env` replaces the process environment instead of overlaying it. */
  inheritEnv?: boolean;
  timeoutMs?: number;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Canonical command runner contract:
 * Pipes `input` directly to child process `stdin` without shell string interpolation.
 */
export async function runCommand(
  command: string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  if (!command || command.length === 0) {
    throw new Error('runCommand requires a non-empty command array');
  }

  const [executable, ...args] = command;
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const timeoutMs = options.timeoutMs ?? 60_000;

  return new Promise<RunCommandResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: options.inheritEnv === false ? { ...options.env } : { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          stdout,
          stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms`.trim(),
          exitCode: 124,
        });
        return;
      }
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    if (options.input !== undefined) {
      child.stdin.write(options.input, 'utf-8');
    }
    child.stdin.end();
  });
}

export interface SkillDirResolution {
  found: boolean;
  skillDir: string | null;
  source: 'repo' | 'global' | null;
}

/**
 * Resolves Gantry skill pack in canonical priority order:
 * 1. `<repoRoot>/.agents/skills/gantry`
 * 2. `<homeDir>/.agents/skills/gantry`
 */
export function resolveSkillDir(repoRoot: string, homeDir: string = os.homedir()): SkillDirResolution {
  const repoSkill = path.join(path.resolve(repoRoot), '.agents', 'skills', 'gantry');
  if (fs.existsSync(path.join(repoSkill, 'SKILL.md')) || fs.existsSync(path.join(repoSkill, 'scripts'))) {
    return {
      found: true,
      skillDir: fs.realpathSync(repoSkill),
      source: 'repo',
    };
  }

  const globalSkill = path.join(path.resolve(homeDir), '.agents', 'skills', 'gantry');
  if (fs.existsSync(path.join(globalSkill, 'SKILL.md')) || fs.existsSync(path.join(globalSkill, 'scripts'))) {
    return {
      found: true,
      skillDir: fs.realpathSync(globalSkill),
      source: 'global',
    };
  }

  return {
    found: false,
    skillDir: null,
    source: null,
  };
}

export interface RunGantryScriptOptions extends RunCommandOptions {
  repoRoot: string;
  skillDir?: string;
}

export async function runGantryScript(
  scriptName: string,
  args: string[],
  options: RunGantryScriptOptions,
): Promise<RunCommandResult> {
  const skillDir = options.skillDir ?? resolveSkillDir(options.repoRoot).skillDir;
  if (!skillDir) {
    throw new Error(`Gantry skill directory not found for repository ${options.repoRoot}`);
  }
  const scriptPath = path.join(skillDir, 'scripts', scriptName);
  const python = findExecutable('python3') ?? (process.platform === 'win32' ? findExecutable('python') : null);
  if (!python) throw new Error('Python 3 não foi encontrado. Instale-o e adicione-o ao PATH para executar os workflows do Gantry.');
  return runCommand([python, scriptPath, ...args], {
    cwd: options.cwd ?? options.repoRoot,
    input: options.input,
    env: { PYTHONDONTWRITEBYTECODE: '1', ...options.env },
    timeoutMs: options.timeoutMs,
  });
}
