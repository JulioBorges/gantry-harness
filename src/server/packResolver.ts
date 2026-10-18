import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findExecutable } from './commandRunner.js';
import type { BoardPayload, PackResolution } from '../types.js';

const EMPTY_BOARD: BoardPayload = { issues: [], specs: [], frontier: [] };

/**
 * Resolve the Gantry pack for a repository.
 * The pinned copy wins. A `gantry` executable on PATH is only the fallback.
 */
export function resolveGantryPack(repoPath: string): PackResolution {
  const pinnedPath = path.join(repoPath, '.agents', 'skills', 'gantry', 'scripts', 'cli.py');
  if (fs.existsSync(pinnedPath) && fs.statSync(pinnedPath).isFile()) {
    return { kind: 'pinned', cliPath: pinnedPath };
  }

  const executable = findExecutable('gantry');
  if (executable) {
    return { kind: 'path', executable };
  }

  return { kind: 'none' };
}

export function boardCommand(repoPath: string, resolution: Exclude<PackResolution, { kind: 'none' }>): {
  command: string;
  args: string[];
} {
  if (resolution.kind === 'pinned') {
    return {
      command: 'python3',
      args: [resolution.cliPath, '--cwd', repoPath, 'board'],
    };
  }
  return {
    command: resolution.executable,
    args: ['board', '--cwd', repoPath],
  };
}

/**
 * Run the pack's `board` command and return its JSON object.
 * Every call spawns the pack again, so a refresh sees the repository as it is now.
 */
export function readBoard(repoPath: string, resolution: PackResolution): Promise<BoardPayload> {
  if (resolution.kind === 'none') {
    return Promise.resolve(EMPTY_BOARD);
  }

  const { command, args } = boardCommand(repoPath, resolution);

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err: Error) => {
      reject(new Error(`Failed to spawn pack board command: ${err.message}`));
    });
    proc.on('close', (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`Pack board command failed: ${stderr || stdout || 'Unknown error'}`));
        return;
      }
      try {
        resolve(parseBoard(stdout));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(`Failed to parse board JSON: ${err}`));
      }
    });
  });
}

function parseBoard(stdout: string): BoardPayload {
  const parsed = JSON.parse(stdout) as Partial<BoardPayload>;
  if (!Array.isArray(parsed.issues) || !Array.isArray(parsed.specs) || !Array.isArray(parsed.frontier)) {
    throw new Error('Board output is missing issues, specs, or frontier');
  }
  return {
    issues: parsed.issues,
    specs: parsed.specs,
    frontier: parsed.frontier,
  };
}
