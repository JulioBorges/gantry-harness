import { effectiveCommandRoles, missingCommand, withRoleCommands } from './roleCommands.js';
import { spawn } from 'cross-spawn';
import { execFileSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isSetupRefusalError,
  phaseToExecutionLane,
  type BoardSnapshot,
  type ExecutionLane,
  type GantryErrorPayload,
  type HarnessRunKind,
  type HarnessRunPause,
  type HarnessRunRecord,
} from '../boardModel.js';
import type { RegisteredProject } from '../types.js';
import { findExecutable, runCommand } from './commandRunner.js';
import {
  buildPackCommand,
  deletePackRunRecord,
  expectedWorktreePath,
  hasExistingSpecOrIssue,
  listPackRunRecords,
  normaliseIssueRef,
  readBoard,
  readIssueTitleFromWorktree,
  readPackRunRecord,
  renderExpectedIssueBranch,
  resolvePackExecutable,
} from './gantryCli.js';
import type { HarnessStateStore } from './stateStore.js';

interface SupervisedChild {
  projectId: string;
  repoPath: string;
  ref: string;
  initialKey: string;
  child: ChildProcess;
  record: HarnessRunRecord;
  stdoutBuffer: string;
  pollTimer: NodeJS.Timeout | null;
  waiters: Array<() => void>;
  exited: boolean;
}

export class RunSupervisorError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function normaliseErrorCode(rawError: Record<string, unknown>): GantryErrorPayload {
  const rawCode = typeof rawError.code === 'string' ? rawError.code : 'unknown-error';
  const reason = typeof rawError.reason === 'string' ? rawError.reason : undefined;
  const code = rawCode === 'setup-invalid' && reason ? reason : rawCode;
  const openBlockers = Array.isArray(rawError.openBlockers)
    ? rawError.openBlockers.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    ...rawError,
    code,
    ...(reason ? { reason } : {}),
    ...(openBlockers ? { openBlockers } : {}),
  };
}

function gitBranchExists(repoRoot: string, branch: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function removeLocalWorktree(repoRoot: string, worktree: string | null | undefined): void {
  if (!worktree) return;
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktree], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
  } catch {
    // fallback below
  }
  try {
    if (fs.existsSync(worktree)) {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
    execFileSync('git', ['worktree', 'prune'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
  } catch {
    // ignore cleanup race
  }
}

function removeLocalBranch(repoRoot: string, branch: string | null | undefined): void {
  if (!branch) return;
  try {
    if (gitBranchExists(repoRoot, branch)) {
      execFileSync('git', ['branch', '-D', branch], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
    }
  } catch {
    // ignore cleanup race
  }
}

function ensureWorktreeForBranch(repoRoot: string, branch: string, worktree: string): boolean {
  if (fs.existsSync(worktree)) return true;
  if (!gitBranchExists(repoRoot, branch)) return false;
  try {
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    execFileSync('git', ['worktree', 'add', '--quiet', worktree, branch], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return fs.existsSync(worktree);
  } catch {
    return false;
  }
}

function ghSupportsPrStateInspection(): boolean {
  const ghPath = findExecutable('gh');
  if (!ghPath) return false;
  try {
    const stat = fs.statSync(ghPath);
    if (!stat.isFile()) return false;
    if (stat.size > 65536) {
      return true;
    }
    const content = fs.readFileSync(ghPath, 'utf-8');
    return /\b(view|state|CLOSED|MERGED|OPEN)\b/i.test(content);
  } catch {
    return false;
  }
}

export class RunSupervisor {
  private readonly active = new Map<string, SupervisedChild>();
  private readonly store: HarnessStateStore;
  private readonly broadcast: (payload: Record<string, unknown>) => void;
  private readonly homeDir: string;
  private readonly profileRoot: string;
  private shuttingDown = false;
  private watchTimer: NodeJS.Timeout | null = null;
  private watching = false;

  constructor(options: {
    store: HarnessStateStore;
    broadcast: (payload: Record<string, unknown>) => void;
    homeDir?: string;
    profileRoot?: string;
  }) {
    this.store = options.store;
    this.broadcast = options.broadcast;
    this.homeDir = options.homeDir ?? os.homedir();
    this.profileRoot = options.profileRoot ?? path.join(this.homeDir, ".gantry", "profiles");
    this.startWatcher();
  }

  private startWatcher(): void {
    this.watchTimer = setInterval(() => {
      if (this.shuttingDown || this.watching) return;
      const projects = this.store.listProjects();
      const needsWatch = projects.some((proj) => {
        const runs = this.store.listRuns(proj.id);
        return runs.some(
          (r) =>
            r.status === 'approved-pending-merge' ||
            r.prState === 'closed' ||
            r.prState === 'reopened' ||
            r.status === 'ready-for-approval',
        );
      });
      if (!needsWatch) return;
      this.watching = true;
      void (async () => {
        try {
          for (const project of projects) {
            if (this.shuttingDown) break;
            await this.syncProjectWithTarget(project);
          }
        } catch {
          // ignore background watcher errors
        } finally {
          this.watching = false;
        }
      })();
    }, 300);
    this.watchTimer.unref?.();
  }

  private key(projectId: string, ref: string): string {
    const normalized = ref.includes('#') ? normaliseIssueRef(ref) : ref.trim().toLowerCase();
    return `${projectId}:${normalized}`;
  }

  private findActiveEntry(projectId: string, refOrSlug: string): SupervisedChild | undefined {
    const direct = this.active.get(this.key(projectId, refOrSlug));
    if (direct && !direct.exited) return direct;
    const cleaned = refOrSlug.trim().toLowerCase();
    for (const entry of this.active.values()) {
      if (
        entry.projectId === projectId &&
        !entry.exited &&
        (entry.ref.toLowerCase() === cleaned || entry.record.slug.toLowerCase() === cleaned)
      ) {
        return entry;
      }
    }
    return undefined;
  }

  private findStoredRun(projectId: string, refOrSlug: string): HarnessRunRecord | null {
    const canonical = refOrSlug.includes('#') ? normaliseIssueRef(refOrSlug) : refOrSlug.trim();
    const direct = this.store.getRun(projectId, canonical);
    if (direct) return direct;
    const lower = canonical.toLowerCase();
    const all = this.store.listRuns(projectId);
    return (
      [...all]
        .reverse()
        .find((item) => item.ref.toLowerCase() === lower || item.slug.toLowerCase() === lower) ??
      null
    );
  }

  private notifyWaiters(entry: SupervisedChild): void {
    const callbacks = entry.waiters.splice(0);
    for (const cb of callbacks) {
      cb();
    }
  }

  private waitForNextActivity(entry: SupervisedChild, timeoutMs: number): Promise<void> {
    if (entry.exited) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      entry.waiters.push(done);
    });
  }

  private syncPackPhase(entry: SupervisedChild, emitIfChanged: boolean): boolean {
    const pack = entry.ref.includes('#')
      ? readPackRunRecord(entry.repoPath, entry.ref)
      : (readPackRunRecord(entry.repoPath, entry.ref) ??
        readPackRunRecord(entry.repoPath, entry.record.slug));
    if (!pack) return false;

    const canonicalPackRef = normaliseIssueRef(pack.ref);
    const refChanged = canonicalPackRef !== entry.ref;
    if (refChanged) {
      const oldRef = entry.ref;
      const oldKey = this.key(entry.projectId, oldRef);
      this.active.delete(oldKey);
      this.store.deleteRun(entry.projectId, oldRef);
      entry.ref = canonicalPackRef;
      entry.record.ref = canonicalPackRef;
      this.active.set(this.key(entry.projectId, canonicalPackRef), entry);
    }

    const nextLane = phaseToExecutionLane(pack.phase, entry.record.lane);
    const phaseChanged = pack.phase !== entry.record.packPhase;
    const laneChanged = nextLane !== entry.record.lane;
    const branchAdded = Boolean(pack.branch && !entry.record.branch);
    const pathsAdded = Boolean(
      (pack.specPath && pack.specPath !== entry.record.specPath) ||
        (pack.issuePath && pack.issuePath !== entry.record.issuePath),
    );

    if (pack.specPath) {
      entry.record.specPath = pack.specPath;
    }
    if (pack.issuePath) {
      entry.record.issuePath = pack.issuePath;
    }
    if (entry.record.worktree && entry.record.issuePath) {
      const title = readIssueTitleFromWorktree(entry.record.worktree, entry.record.issuePath);
      if (title && title !== entry.record.issueTitle) {
        entry.record.issueTitle = title;
      }
    }
    if (entry.record.pause) {
      if (entry.record.specPath) entry.record.pause.specPath = entry.record.specPath;
      if (entry.record.issuePath) entry.record.pause.issuePath = entry.record.issuePath;
    }

    if (!refChanged && !phaseChanged && !laneChanged && !branchAdded && !pathsAdded) {
      return false;
    }

    entry.record.packPhase = pack.phase;
    entry.record.lane = nextLane;
    if (pack.branch && !entry.record.branch) {
      entry.record.branch = pack.branch;
    }
    if (entry.record.status === 'running' && nextLane) {
      entry.record.derivedPhase = nextLane;
    }
    entry.record = this.store.saveRun(entry.record);
    if (emitIfChanged) {
      this.broadcast({
        type: 'run.event',
        projectId: entry.projectId,
        ref: entry.ref,
        event: 'phase',
        phase: pack.phase,
        lane: entry.record.lane,
        run: entry.record,
      });
      this.broadcast({ type: 'board.changed', projectId: entry.projectId });
      this.notifyWaiters(entry);
    }
    return true;
  }

  private handleStdoutLine(entry: SupervisedChild, rawLine: string): void {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) return;
    entry.record.stdoutLines = [...(entry.record.stdoutLines ?? []), line];

    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('stdout line is not a JSON object');
      }
      parsed = value as Record<string, unknown>;
    } catch {
      this.syncPackPhase(entry, false);
      entry.record.status = 'failed';
      entry.record.derivedPhase = 'failed';
      entry.record.pause = null;
      entry.record.pausedReason = null;
      entry.record.pausedChoices = null;
      entry.record.error = {
        code: 'invalid-json',
        message: `Non-JSON stdout line: ${line.slice(0, 240)}`,
      };
      entry.record = this.store.saveRun(entry.record);
      this.broadcast({
        type: 'run.event',
        projectId: entry.projectId,
        ref: entry.ref,
        error: entry.record.error,
        run: entry.record,
      });
      this.broadcast({
        type: 'run.finished',
        projectId: entry.projectId,
        ref: entry.ref,
        error: entry.record.error,
        run: entry.record,
      });
      this.broadcast({ type: 'board.changed', projectId: entry.projectId });
      this.notifyWaiters(entry);
      try {
        entry.child.kill('SIGTERM');
      } catch {
        // ignore kill race
      }
      return;
    }

    this.syncPackPhase(entry, false);

    const roleHint =
      typeof parsed.role === 'string'
        ? parsed.role
        : typeof parsed.phase === 'string'
          ? parsed.phase
          : typeof parsed.column === 'string'
            ? parsed.column
            : null;
    if (roleHint) {
      const mappedLane = phaseToExecutionLane(roleHint, entry.record.lane);
      if (mappedLane) {
        entry.record.packPhase = roleHint.toLowerCase();
        entry.record.lane = mappedLane;
        if (entry.record.status === 'running') {
          entry.record.derivedPhase = mappedLane;
        }
      }
    }

    if (parsed.event === 'worktree') {
      if (typeof parsed.branch === 'string') entry.record.branch = parsed.branch;
      if (typeof parsed.worktree === 'string') entry.record.worktree = parsed.worktree;
      entry.record.pushed = Boolean(parsed.pushed);
      this.syncPackPhase(entry, false);
      const initialLane: ExecutionLane = entry.record.kind === 'plan' ? 'plan' : 'implement';
      entry.record.lane = phaseToExecutionLane(entry.record.packPhase, entry.record.lane ?? initialLane);
      entry.record.derivedPhase = entry.record.lane ?? initialLane;
      entry.record = this.store.saveRun(entry.record);
      this.broadcast({
        type: 'run.event',
        projectId: entry.projectId,
        ref: entry.ref,
        ...parsed,
        gantryEvent: parsed,
        run: entry.record,
      });
      this.broadcast({ type: 'board.changed', projectId: entry.projectId });
      this.notifyWaiters(entry);
      return;
    }

    if (parsed.event === 'pause') {
      const reason = typeof parsed.reason === 'string' ? parsed.reason : 'pause';
      const choices = Array.isArray(parsed.choices)
        ? parsed.choices.filter((choice): choice is string => typeof choice === 'string')
        : [];
      if (typeof parsed.branch === 'string') entry.record.branch = parsed.branch;
      if (typeof parsed.worktree === 'string') entry.record.worktree = parsed.worktree;
      entry.record.pushed = Boolean(parsed.pushed);
      this.syncPackPhase(entry, false);
      if (reason === 'plan-approval' || reason === 'plan-dirty') {
        entry.record.lane = 'plan';
      } else {
        entry.record.lane = phaseToExecutionLane(entry.record.packPhase, entry.record.lane ?? 'implement');
      }
      if (entry.record.worktree && entry.record.issuePath) {
        const title = readIssueTitleFromWorktree(entry.record.worktree, entry.record.issuePath);
        if (title) entry.record.issueTitle = title;
      }
      const pauseObj: HarnessRunPause = {
        reason,
        choices,
        branch: entry.record.branch ?? '',
        worktree: entry.record.worktree ?? '',
        pushed: entry.record.pushed,
        ...(typeof parsed.prompt === 'string' ? { prompt: parsed.prompt } : {}),
        ...(entry.record.specPath ? { specPath: entry.record.specPath } : {}),
        ...(entry.record.issuePath ? { issuePath: entry.record.issuePath } : {}),
      };
      entry.record.status = 'paused';
      entry.record.pause = pauseObj;
      entry.record.pausedReason = reason;
      entry.record.pausedChoices = choices;
      entry.record.derivedPhase = 'paused';
      entry.record = this.store.saveRun(entry.record);
      this.broadcast({
        type: 'run.event',
        projectId: entry.projectId,
        ref: entry.ref,
        ...parsed,
        gantryEvent: parsed,
        run: entry.record,
      });
      this.broadcast({
        type: 'run.paused',
        projectId: entry.projectId,
        ref: entry.ref,
        pause: pauseObj,
        run: entry.record,
      });
      this.broadcast({ type: 'board.changed', projectId: entry.projectId });
      this.notifyWaiters(entry);
      return;
    }

    if (parsed.event === 'stopped') {
      if (typeof parsed.branch === 'string') entry.record.branch = parsed.branch;
      if (typeof parsed.worktree === 'string') entry.record.worktree = parsed.worktree;
      entry.record.pushed = Boolean(parsed.pushed);
      entry.record.status = 'stopped';
      entry.record.terminalEvent = 'stopped';
      entry.record.pause = null;
      entry.record.pausedReason = null;
      entry.record.pausedChoices = null;
      entry.record.lane = phaseToExecutionLane(entry.record.packPhase, entry.record.lane ?? 'implement');
      entry.record.derivedPhase = 'stopped';
      entry.record = this.store.saveRun(entry.record);
      this.broadcast({
        type: 'run.event',
        projectId: entry.projectId,
        ref: entry.ref,
        ...parsed,
        gantryEvent: parsed,
        run: entry.record,
      });
      this.broadcast({
        type: 'run.finished',
        projectId: entry.projectId,
        ref: entry.ref,
        ...parsed,
        gantryEvent: parsed,
        run: entry.record,
      });
      this.broadcast({ type: 'board.changed', projectId: entry.projectId });
      this.notifyWaiters(entry);
      return;
    }

    if (parsed.event === 'ready-for-approval') {
      if (typeof parsed.branch === 'string') entry.record.branch = parsed.branch;
      if (typeof parsed.worktree === 'string') entry.record.worktree = parsed.worktree;
      entry.record.pushed = Boolean(parsed.pushed);
      entry.record.status = 'ready-for-approval';
      entry.record.terminalEvent = 'ready-for-approval';
      entry.record.pause = null;
      entry.record.pausedReason = null;
      entry.record.pausedChoices = null;
      entry.record.packPhase = 'ready';
      entry.record.lane = 'critic';
      entry.record.derivedPhase = 'ready-for-approval';
      entry.record = this.store.saveRun(entry.record);
      this.broadcast({
        type: 'run.event',
        projectId: entry.projectId,
        ref: entry.ref,
        ...parsed,
        gantryEvent: parsed,
        run: entry.record,
      });
      this.broadcast({
        type: 'run.finished',
        projectId: entry.projectId,
        ref: entry.ref,
        ...parsed,
        gantryEvent: parsed,
        run: entry.record,
      });
      this.broadcast({ type: 'board.changed', projectId: entry.projectId });
      this.notifyWaiters(entry);
      return;
    }

    if (parsed.event === 'rejected' || parsed.event === 'discarded') {
      if (typeof parsed.branch === 'string') entry.record.branch = parsed.branch;
      entry.record.pushed = Boolean(parsed.pushed);
      entry.record.status = parsed.event;
      entry.record.terminalEvent = parsed.event;
      entry.record.pause = null;
      entry.record.pausedReason = null;
      entry.record.pausedChoices = null;
      entry.record.worktree = null;
      entry.record.lane = null;
      entry.record.derivedPhase = 'ready-to-agent';
      this.store.deleteRun(entry.projectId, entry.ref);
      this.store.deleteRun(entry.projectId, entry.record.slug);
      this.broadcast({
        type: 'run.event',
        projectId: entry.projectId,
        ref: entry.ref,
        ...parsed,
        gantryEvent: parsed,
        run: entry.record,
      });
      this.broadcast({
        type: 'run.finished',
        projectId: entry.projectId,
        ref: entry.ref,
        ...parsed,
        gantryEvent: parsed,
        run: entry.record,
      });
      this.broadcast({ type: 'board.changed', projectId: entry.projectId });
      this.notifyWaiters(entry);
      return;
    }

    if (parsed.event === 'pull-request') {
      if (typeof parsed.branch === 'string') entry.record.branch = parsed.branch;
      if (typeof parsed.worktree === 'string') entry.record.worktree = parsed.worktree;
      entry.record.pushed = Boolean(parsed.pushed);
      entry.record.createdCommit = Boolean(parsed.createdCommit);
      entry.record.prUrl = typeof parsed.url === 'string' ? parsed.url : null;
      entry.record.prState = 'open';
      entry.record.status = 'approved-pending-merge';
      entry.record.terminalEvent = 'pull-request';
      entry.record.pause = null;
      entry.record.pausedReason = null;
      entry.record.pausedChoices = null;
      entry.record.error = null;
      entry.record.derivedPhase = 'approved-pending-merge';
      entry.record = this.store.saveRun(entry.record);
      this.broadcast({
        type: 'run.event',
        projectId: entry.projectId,
        ref: entry.ref,
        ...parsed,
        gantryEvent: parsed,
        run: entry.record,
      });
      this.broadcast({
        type: 'run.finished',
        projectId: entry.projectId,
        ref: entry.ref,
        ...parsed,
        gantryEvent: parsed,
        run: entry.record,
      });
      this.broadcast({ type: 'board.changed', projectId: entry.projectId });
      this.notifyWaiters(entry);
      return;
    }

    if (parsed.error && typeof parsed.error === 'object') {
      const errorPayload = normaliseErrorCode(parsed.error as Record<string, unknown>);
      entry.record.status = 'failed';
      entry.record.error = errorPayload;
      entry.record.pause = null;
      entry.record.pausedReason = null;
      entry.record.pausedChoices = null;
      if (!entry.record.worktree && isSetupRefusalError(errorPayload)) {
        entry.record.lane = null;
        entry.record.derivedPhase = errorPayload.code === 'open-blocker' ? 'blocked' : 'ready-to-agent';
      } else {
        entry.record.derivedPhase = 'failed';
      }
      entry.record = this.store.saveRun(entry.record);
      this.broadcast({
        type: 'run.event',
        projectId: entry.projectId,
        ref: entry.ref,
        error: errorPayload,
        gantryEvent: parsed,
        run: entry.record,
      });
      this.broadcast({
        type: 'run.finished',
        projectId: entry.projectId,
        ref: entry.ref,
        error: errorPayload,
        gantryEvent: parsed,
        run: entry.record,
      });
      this.broadcast({ type: 'board.changed', projectId: entry.projectId });
      this.notifyWaiters(entry);
      return;
    }

    entry.record = this.store.saveRun(entry.record);
    this.broadcast({
      type: 'run.event',
      projectId: entry.projectId,
      ref: entry.ref,
      ...parsed,
      gantryEvent: parsed,
      run: entry.record,
    });
    this.broadcast({ type: 'board.changed', projectId: entry.projectId });
    this.notifyWaiters(entry);
  }

  private attachSupervisedChild(
    project: RegisteredProject,
    ref: string,
    command: string[],
    initialRecord: HarnessRunRecord,
  ): SupervisedChild {
    command = withRoleCommands(command, effectiveCommandRoles(project, this.profileRoot, this.store.getGlobalExecution().roles));
    const child = spawn(command[0], command.slice(1), {
      cwd: project.path,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    const pid = child.pid ?? null;
    initialRecord.childPid = pid;
    initialRecord.pid = pid;
    initialRecord.childHandle = pid ? `pid:${pid}` : null;

    const initialKey = this.key(project.id, ref);
    const entry: SupervisedChild = {
      projectId: project.id,
      repoPath: project.path,
      ref,
      initialKey,
      child,
      record: this.store.saveRun(initialRecord),
      stdoutBuffer: '',
      pollTimer: null,
      waiters: [],
      exited: false,
    };

    this.active.set(initialKey, entry);

    entry.pollTimer = setInterval(() => {
      if (!entry.exited) {
        this.syncPackPhase(entry, true);
      }
    }, 15);
    entry.pollTimer.unref?.();

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');

    child.stdout?.on('data', (chunk: string) => {
      entry.stdoutBuffer += chunk;
      let newlineIndex = entry.stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = entry.stdoutBuffer.slice(0, newlineIndex);
        entry.stdoutBuffer = entry.stdoutBuffer.slice(newlineIndex + 1);
        this.handleStdoutLine(entry, line);
        newlineIndex = entry.stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr?.on('data', (chunk: string) => {
      entry.record.stderrText = `${entry.record.stderrText ?? ''}${chunk}`;
    });

    child.on('error', (err) => {
      if (entry.pollTimer) {
        clearInterval(entry.pollTimer);
        entry.pollTimer = null;
      }
      entry.exited = true;
      entry.record.childPid = null;
      entry.record.pid = null;
      entry.record.childHandle = null;
      entry.record.status = 'failed';
      entry.record.derivedPhase = 'failed';
      entry.record.pause = null;
      entry.record.pausedReason = null;
      entry.record.pausedChoices = null;
      entry.record.error = {
        code: 'spawn-error',
        message: err.message,
      };
      entry.record = this.store.saveRun(entry.record);
      this.active.delete(entry.initialKey);
      this.active.delete(this.key(entry.projectId, entry.ref));
      this.broadcast({
        type: 'run.finished',
        projectId: entry.projectId,
        ref: entry.ref,
        error: entry.record.error,
        run: entry.record,
      });
      this.broadcast({ type: 'board.changed', projectId: entry.projectId });
      this.notifyWaiters(entry);
    });

    child.on('close', (code) => {
      if (entry.pollTimer) {
        clearInterval(entry.pollTimer);
        entry.pollTimer = null;
      }
      if (entry.stdoutBuffer.trim().length > 0) {
        const trailing = entry.stdoutBuffer;
        entry.stdoutBuffer = '';
        for (const line of trailing.split('\n')) {
          this.handleStdoutLine(entry, line);
        }
      }
      this.syncPackPhase(entry, false);
      entry.exited = true;
      entry.record.childPid = null;
      entry.record.pid = null;
      entry.record.childHandle = null;
      entry.record.exitCode = code ?? 1;

      this.active.delete(entry.initialKey);
      this.active.delete(this.key(entry.projectId, entry.ref));

      if (entry.record.status === 'rejected' || entry.record.status === 'discarded') {
        this.store.deleteRun(entry.projectId, entry.ref);
        this.store.deleteRun(entry.projectId, entry.record.slug);
        this.notifyWaiters(entry);
        return;
      }

      if (this.shuttingDown) {
        if (entry.record.status === 'running' || entry.record.status === 'paused') {
          entry.record.status = 'stopped';
          entry.record.derivedPhase = 'stopped';
          entry.record.pause = null;
          entry.record.pausedReason = null;
          entry.record.pausedChoices = null;
          entry.record = this.store.saveRun(entry.record);
        }
        this.notifyWaiters(entry);
        return;
      }

      const hadUnansweredPause = entry.record.status === 'paused' || entry.record.pause !== null;
      if (hadUnansweredPause) {
        const unansweredReason = entry.record.pause?.reason ?? 'pause';
        entry.record.status = 'failed';
        entry.record.derivedPhase = 'failed';
        entry.record.pause = null;
        entry.record.pausedReason = null;
        entry.record.pausedChoices = null;
        entry.record.error = entry.record.error ?? {
          code: 'unanswered-pause-exit',
          reason: unansweredReason,
          message: `Process exited (${code ?? 'signal'}) while pause "${unansweredReason}" was unanswered.`,
        };
      } else if (!entry.record.terminalEvent && !entry.record.error) {
        entry.record.status = 'failed';
        entry.record.derivedPhase = 'failed';
        entry.record.error = {
          code: 'unexpected-exit',
          exitCode: code ?? 1,
          message:
            entry.record.stderrText?.trim() ||
            `Process exited (${code ?? 'signal'}) without a terminal event.`,
        };
      }

      entry.record = this.store.saveRun(entry.record);

      if (hadUnansweredPause || (!entry.record.terminalEvent && entry.record.status === 'failed')) {
        this.broadcast({
          type: 'run.finished',
          projectId: entry.projectId,
          ref: entry.ref,
          error: entry.record.error,
          run: entry.record,
        });
        this.broadcast({ type: 'board.changed', projectId: entry.projectId });
      }
      this.notifyWaiters(entry);
    });

    return entry;
  }

  public async startRun(params: {
    project: RegisteredProject;
    ref?: string;
    slug?: string;
    kind?: HarnessRunKind;
  }): Promise<HarnessRunRecord> {
    const rawInput = (params.ref || params.slug || '').trim();
    if (!rawInput) {
      throw new RunSupervisorError(400, 'issue-missing', 'A referência da Issue ou slug do Plan é obrigatória.');
    }
    const kind: HarnessRunKind = params.kind ?? (rawInput.includes('#') ? 'issue' : 'plan');
    const slug = rawInput.includes('#') ? rawInput.split('#')[0].toLowerCase() : rawInput.toLowerCase();
    const ref = kind === 'issue' ? normaliseIssueRef(rawInput) : slug;

    const existingActive = this.findActiveEntry(params.project.id, ref);
    if (existingActive && !existingActive.exited) {
      throw new RunSupervisorError(409, 'run-already-active', `Run ${existingActive.ref} já está em execução.`);
    }

    const resolved = resolvePackExecutable(params.project.path, this.homeDir);
    if (resolved.kind === 'none') {
      throw new RunSupervisorError(400, 'pack-unavailable', resolved.explanation);
    }

    // Validate executable commands before creating any Run or Git artifacts.
    const usesPythonPolicy = (resolved.kind === 'pinned' || resolved.kind === 'global') && fs.existsSync(path.join(path.dirname(resolved.cliPath), 'common.py'));
    const missingRole = usesPythonPolicy ? missingCommand(effectiveCommandRoles(params.project, this.profileRoot, this.store.getGlobalExecution().roles), kind) : undefined;
    if (missingRole) {
      throw new RunSupervisorError(400, 'role-command-missing', `O papel ${missingRole} precisa de um comando executável. Configure este projeto antes de executar a Issue.`);
    }
    if (kind === 'plan' && hasExistingSpecOrIssue(params.project.path, slug)) {
      const now = new Date().toISOString();
      const errorPayload: GantryErrorPayload = {
        code: 'spec-or-issue-exists',
        reason: 'spec-or-issue-exists',
      };
      const failedRecord: HarnessRunRecord = {
        runId: `run-${crypto.randomUUID().slice(0, 8)}`,
        projectId: params.project.id,
        ref: `${slug}#01`,
        slug,
        kind: 'plan',
        status: 'failed',
        childPid: null,
        pid: null,
        childHandle: null,
        lane: null,
        packPhase: null,
        branch: null,
        worktree: null,
        pushed: false,
        pause: null,
        pausedReason: null,
        pausedChoices: null,
        terminalEvent: null,
        error: errorPayload,
        prUrl: null,
        derivedPhase: 'ready-to-agent',
        stdoutLines: [],
        stderrText: '',
        exitCode: 2,
        createdAt: now,
        updatedAt: now,
      };
      const saved = this.store.saveRun(failedRecord);
      this.broadcast({
        type: 'run.event',
        projectId: params.project.id,
        ref: saved.ref,
        error: errorPayload,
        run: saved,
      });
      this.broadcast({
        type: 'run.finished',
        projectId: params.project.id,
        ref: saved.ref,
        error: errorPayload,
        run: saved,
      });
      this.broadcast({ type: 'board.changed', projectId: params.project.id });
      return saved;
    }

    const executeArg = kind === 'plan' ? slug : ref;
    const command = buildPackCommand(resolved, params.project.path, 'execute', executeArg);
    const now = new Date().toISOString();
    const initialLane: ExecutionLane = kind === 'plan' ? 'plan' : 'implement';

    const initialRecord: HarnessRunRecord = {
      runId: `run-${crypto.randomUUID().slice(0, 8)}`,
      projectId: params.project.id,
      ref,
      slug,
      kind,
      status: 'running',
      childPid: null,
      pid: null,
      childHandle: null,
      lane: initialLane,
      packPhase: initialLane,
      branch: null,
      worktree: null,
      pushed: false,
      pause: null,
      pausedReason: null,
      pausedChoices: null,
      terminalEvent: null,
      error: null,
      prUrl: null,
      derivedPhase: initialLane,
      stdoutLines: [],
      stderrText: '',
      exitCode: null,
      createdAt: now,
      updatedAt: now,
    };

    const entry = this.attachSupervisedChild(params.project, ref, command, initialRecord);
    await this.waitForInitialEvent(entry, 2000);
    this.syncPackPhase(entry, false);
    return entry.record;
  }

  private async waitForInitialEvent(entry: SupervisedChild, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (
      !entry.exited &&
      !entry.record.worktree &&
      entry.record.status === 'running' &&
      (entry.record.stdoutLines?.length ?? 0) === 0
    ) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.waitForNextActivity(entry, remaining);
    }
  }

  public async executeWave(params: {
    project: RegisteredProject;
  }): Promise<{ runs: HarnessRunRecord[]; frontier: string[] }> {
    const board = await readBoard(params.project.path, this.homeDir);
    if (!board.executionEnabled) {
      throw new RunSupervisorError(
        400,
        'pack-unavailable',
        board.explanation ?? 'O pack do Gantry não está disponível neste projeto.',
      );
    }

    const issueByRef = new Map(board.issues.map((issue) => [issue.ref, issue]));
    const runnableFrontier = board.frontier.filter((ref) => {
      const issue = issueByRef.get(ref);
      if (!issue) return true;
      return issue.status !== 'done' && !issue.frontierBlocked;
    });

    const startedEntries: Array<{ entry?: SupervisedChild; record: HarnessRunRecord }> = [];
    for (const ref of runnableFrontier) {
      const active = this.findActiveEntry(params.project.id, ref);
      if (active && !active.exited) {
        startedEntries.push({ record: active.record });
        continue;
      }
      const entry = this.spawnIssueEntry(params.project, ref);
      // Wait briefly for worktree creation so concurrent git worktree commands do not contend on .git locks
      await this.waitForInitialEvent(entry, 500);
      this.syncPackPhase(entry, false);
      startedEntries.push({ entry, record: entry.record });
    }

    return {
      runs: startedEntries.map((item) => (item.entry ? item.entry.record : item.record)),
      frontier: runnableFrontier,
    };
  }

  private spawnIssueEntry(project: RegisteredProject, rawRef: string): SupervisedChild {
    const resolved = resolvePackExecutable(project.path, this.homeDir);
    if (resolved.kind === 'none') {
      throw new RunSupervisorError(400, 'pack-unavailable', resolved.explanation);
    }
    const ref = normaliseIssueRef(rawRef);
    const slug = ref.split('#')[0].toLowerCase();
    const command = buildPackCommand(resolved, project.path, 'execute', ref);
    const now = new Date().toISOString();
    const initialRecord: HarnessRunRecord = {
      runId: `run-${crypto.randomUUID().slice(0, 8)}`,
      projectId: project.id,
      ref,
      slug,
      kind: 'issue',
      status: 'running',
      childPid: null,
      pid: null,
      childHandle: null,
      lane: 'implement',
      packPhase: 'implement',
      branch: null,
      worktree: null,
      pushed: false,
      pause: null,
      pausedReason: null,
      pausedChoices: null,
      terminalEvent: null,
      error: null,
      prUrl: null,
      derivedPhase: 'implement',
      stdoutLines: [],
      stderrText: '',
      exitCode: null,
      createdAt: now,
      updatedAt: now,
    };
    return this.attachSupervisedChild(project, ref, command, initialRecord);
  }

  public async answerPause(params: {
    projectId: string;
    ref: string;
    choice: string;
  }): Promise<HarnessRunRecord> {
    const entry = this.findActiveEntry(params.projectId, params.ref);
    const stored = entry?.record ?? this.findStoredRun(params.projectId, params.ref);

    if (!stored) {
      throw new RunSupervisorError(404, 'run-not-found', `Run não encontrada para ${params.ref}.`);
    }

    if (!entry || entry.exited || entry.record.status !== 'paused' || !entry.record.pause) {
      throw new RunSupervisorError(
        409,
        'no-pause-outstanding',
        `Run ${stored.ref} não aguarda resposta de pausa.`,
      );
    }

    const choice = params.choice.trim();
    const allowedChoices = entry.record.pause.choices;
    if (!allowedChoices.includes(choice)) {
      throw new RunSupervisorError(
        400,
        'invalid-choice',
        `Escolha inválida "${choice}". Opções permitidas: ${allowedChoices.join(', ')}.`,
      );
    }

    if (!entry.child.stdin || !entry.child.stdin.writable) {
      throw new RunSupervisorError(
        409,
        'stdin-closed',
        `Entrada do processo da Run ${entry.ref} não está disponível.`,
      );
    }

    const prevStdoutLen = entry.record.stdoutLines?.length ?? 0;
    entry.record.pause = null;
    entry.record.pausedReason = null;
    entry.record.pausedChoices = null;
    entry.record.status = 'running';
    entry.record.derivedPhase = entry.record.lane ?? 'implement';
    entry.record = this.store.saveRun(entry.record);

    entry.child.stdin.write(`${choice}\n`, 'utf-8');
    this.broadcast({
      type: 'run.event',
      projectId: entry.projectId,
      ref: entry.ref,
      event: 'answer',
      choice,
      run: entry.record,
    });
    this.broadcast({ type: 'board.changed', projectId: entry.projectId });

    const waitMs = choice === 'reject' || choice === 'stop' ? 2000 : 300;
    const deadline = Date.now() + waitMs;
    while (
      !entry.exited &&
      entry.record.status === 'running' &&
      (entry.record.stdoutLines?.length ?? 0) === prevStdoutLen
    ) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.waitForNextActivity(entry, remaining);
    }
    return entry.record;
  }

  public async resumeRun(params: {
    project: RegisteredProject;
    ref: string;
  }): Promise<HarnessRunRecord> {
    const rawRef = params.ref.trim();
    if (!rawRef) {
      throw new RunSupervisorError(400, 'issue-missing', 'A referência da Issue é obrigatória.');
    }

    const existingActive = this.findActiveEntry(params.project.id, rawRef);
    if (existingActive && !existingActive.exited) {
      throw new RunSupervisorError(409, 'run-already-active', `Run ${existingActive.ref} já está em execução.`);
    }

    const resolved = resolvePackExecutable(params.project.path, this.homeDir);
    if (resolved.kind === 'none') {
      throw new RunSupervisorError(400, 'pack-unavailable', resolved.explanation);
    }

    const pack = readPackRunRecord(params.project.path, rawRef);
    const stored = this.findStoredRun(params.project.id, pack?.ref ?? rawRef);
    const canonicalRef = pack?.ref ?? stored?.ref ?? normaliseIssueRef(rawRef);
    const slug = canonicalRef.split('#')[0] ?? canonicalRef;
    const kind: HarnessRunKind =
      pack?.specPath || pack?.issuePath || stored?.kind === 'plan' ? 'plan' : 'issue';
    const initialLane: ExecutionLane =
      phaseToExecutionLane(
        pack?.phase ?? stored?.packPhase,
        stored?.lane ?? (kind === 'plan' ? 'plan' : 'implement'),
      ) ?? 'implement';
    const branch = pack?.branch ?? stored?.branch ?? renderExpectedIssueBranch(params.project.path, canonicalRef);
    const worktree =
      stored?.worktree ?? (branch ? expectedWorktreePath(params.project.path, branch) : null);

    const now = new Date().toISOString();
    const recordToResume: HarnessRunRecord = {
      runId: stored?.runId ?? `run-${crypto.randomUUID().slice(0, 8)}`,
      projectId: params.project.id,
      ref: canonicalRef,
      slug,
      kind,
      status: 'running',
      childPid: null,
      pid: null,
      childHandle: null,
      lane: initialLane,
      packPhase: pack?.phase ?? stored?.packPhase ?? initialLane,
      branch: branch ?? null,
      worktree: worktree && fs.existsSync(worktree) ? worktree : stored?.worktree ?? null,
      pushed: stored?.pushed ?? false,
      pause: null,
      pausedReason: null,
      pausedChoices: null,
      terminalEvent: null,
      error: null,
      prUrl: stored?.prUrl ?? null,
      derivedPhase: initialLane,
      specPath: pack?.specPath ?? stored?.specPath ?? null,
      issuePath: pack?.issuePath ?? stored?.issuePath ?? null,
      issueTitle: stored?.issueTitle ?? null,
      stdoutLines: stored?.stdoutLines ?? [],
      stderrText: '',
      exitCode: null,
      createdAt: stored?.createdAt ?? now,
      updatedAt: now,
    };

    const prevStdoutLen = recordToResume.stdoutLines?.length ?? 0;
    const command = buildPackCommand(resolved, params.project.path, 'resume', canonicalRef);
    const entry = this.attachSupervisedChild(params.project, canonicalRef, command, recordToResume);

    const deadline = Date.now() + 1000;
    while (
      !entry.exited &&
      entry.record.status === 'running' &&
      (entry.record.stdoutLines?.length ?? 0) === prevStdoutLen
    ) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.waitForNextActivity(entry, remaining);
    }
    this.syncPackPhase(entry, false);
    return entry.record;
  }

  public async discardRun(params: {
    project: RegisteredProject;
    ref: string;
  }): Promise<HarnessRunRecord> {
    const rawRef = params.ref.trim();
    if (!rawRef) {
      throw new RunSupervisorError(400, 'issue-missing', 'A referência da Issue é obrigatória.');
    }

    const active = this.findActiveEntry(params.project.id, rawRef);
    if (active && !active.exited) {
      if (active.pollTimer) {
        clearInterval(active.pollTimer);
        active.pollTimer = null;
      }
      active.exited = true;
      this.active.delete(active.initialKey);
      this.active.delete(this.key(params.project.id, active.ref));
      try {
        active.child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }

    const pack = readPackRunRecord(params.project.path, rawRef);
    const stored = active?.record ?? this.findStoredRun(params.project.id, pack?.ref ?? rawRef);
    const canonicalRef = pack?.ref ?? stored?.ref ?? normaliseIssueRef(rawRef);
    const slug = canonicalRef.split('#')[0] ?? canonicalRef;

    const resolved = resolvePackExecutable(params.project.path, this.homeDir);
    if (resolved.kind === 'none') {
      throw new RunSupervisorError(400, 'pack-unavailable', resolved.explanation);
    }

    const command = buildPackCommand(resolved, params.project.path, 'discard', canonicalRef);
    const result = await runCommand(command, {
      cwd: params.project.path,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    const lines = result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    let parsedEvent: Record<string, unknown> | null = null;
    for (const line of lines) {
      try {
        parsedEvent = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // ignore
      }
    }

    const branch =
      (typeof parsedEvent?.branch === 'string' ? parsedEvent.branch : null) ??
      pack?.branch ??
      stored?.branch ??
      renderExpectedIssueBranch(params.project.path, canonicalRef);
    const worktree =
      stored?.worktree ?? (branch ? expectedWorktreePath(params.project.path, branch) : null);

    // Ensure worktree, branch, and pack record are removed even if the run was interrupted in another state
    if (result.exitCode !== 0 && (stored || pack)) {
      removeLocalWorktree(params.project.path, worktree);
      removeLocalBranch(params.project.path, branch);
      deletePackRunRecord(params.project.path, canonicalRef);
    }

    const now = new Date().toISOString();
    const discardedRecord: HarnessRunRecord = {
      runId: stored?.runId ?? `run-${crypto.randomUUID().slice(0, 8)}`,
      projectId: params.project.id,
      ref: canonicalRef,
      slug,
      kind: stored?.kind ?? (pack?.specPath ? 'plan' : 'issue'),
      status: 'discarded',
      childPid: null,
      pid: null,
      childHandle: null,
      lane: null,
      packPhase: null,
      branch: branch ?? null,
      worktree: null,
      pushed: false,
      pause: null,
      pausedReason: null,
      pausedChoices: null,
      terminalEvent: 'discarded',
      error: null,
      prUrl: null,
      derivedPhase: 'ready-to-agent',
      createdAt: stored?.createdAt ?? now,
      updatedAt: now,
    };

    this.store.deleteRun(params.project.id, canonicalRef);
    this.store.deleteRun(params.project.id, slug);

    this.broadcast({
      type: 'run.event',
      projectId: params.project.id,
      ref: canonicalRef,
      event: 'discarded',
      branch: branch ?? '',
      pushed: false,
      run: discardedRecord,
    });
    this.broadcast({
      type: 'run.finished',
      projectId: params.project.id,
      ref: canonicalRef,
      event: 'discarded',
      branch: branch ?? '',
      pushed: false,
      run: discardedRecord,
    });
    this.broadcast({ type: 'board.changed', projectId: params.project.id });
    return discardedRecord;
  }

  public async approveRun(params: {
    project: RegisteredProject;
    ref: string;
  }): Promise<HarnessRunRecord> {
    const rawRef = params.ref.trim();
    if (!rawRef) {
      throw new RunSupervisorError(400, 'issue-missing', 'A referência da Issue é obrigatória.');
    }

    const resolved = resolvePackExecutable(params.project.path, this.homeDir);
    if (resolved.kind === 'none') {
      throw new RunSupervisorError(400, 'pack-unavailable', resolved.explanation);
    }

    await this.reattachProject(params.project);
    const pack = readPackRunRecord(params.project.path, rawRef);
    const stored = this.findStoredRun(params.project.id, pack?.ref ?? rawRef);
    const canonicalRef = pack?.ref ?? stored?.ref ?? normaliseIssueRef(rawRef);
    const slug = canonicalRef.split('#')[0] ?? canonicalRef;
    const branch =
      stored?.branch ?? pack?.branch ?? renderExpectedIssueBranch(params.project.path, canonicalRef);
    const worktree =
      (stored?.worktree && fs.existsSync(stored.worktree) ? stored.worktree : null) ??
      (branch ? expectedWorktreePath(params.project.path, branch) : null);

    // If the PR was previously closed without merge (worktree removed, branch kept), re-attach the worktree so cli.py approve can run
    if (branch && worktree && !fs.existsSync(worktree)) {
      ensureWorktreeForBranch(params.project.path, branch, worktree);
    }

    const command = buildPackCommand(resolved, params.project.path, 'approve', canonicalRef);
    const result = await runCommand(command, {
      cwd: worktree && fs.existsSync(worktree) ? worktree : params.project.path,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    const now = new Date().toISOString();
    const baseRecord: HarnessRunRecord = stored ?? {
      runId: `run-${crypto.randomUUID().slice(0, 8)}`,
      projectId: params.project.id,
      ref: canonicalRef,
      slug,
      kind: pack?.specPath ? 'plan' : 'issue',
      status: 'ready-for-approval',
      childPid: null,
      pid: null,
      childHandle: null,
      lane: 'critic',
      packPhase: 'ready',
      branch: branch ?? null,
      worktree: worktree && fs.existsSync(worktree) ? worktree : null,
      pushed: false,
      pause: null,
      pausedReason: null,
      pausedChoices: null,
      terminalEvent: 'ready-for-approval',
      error: null,
      prUrl: null,
      derivedPhase: 'ready-for-approval',
      createdAt: now,
      updatedAt: now,
    };

    const lines = result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    let parsed: Record<string, unknown> | null = null;
    for (const line of lines) {
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // ignore non-json line
      }
    }

    if (parsed && parsed.event === 'pull-request') {
      baseRecord.branch = typeof parsed.branch === 'string' ? parsed.branch : baseRecord.branch;
      baseRecord.worktree = typeof parsed.worktree === 'string' ? parsed.worktree : baseRecord.worktree;
      baseRecord.pushed = Boolean(parsed.pushed);
      baseRecord.createdCommit = Boolean(parsed.createdCommit);
      baseRecord.prUrl = typeof parsed.url === 'string' ? parsed.url : null;
      baseRecord.prState = 'open';
      baseRecord.status = 'approved-pending-merge';
      baseRecord.terminalEvent = 'pull-request';
      baseRecord.derivedPhase = 'approved-pending-merge';
      baseRecord.lane = baseRecord.lane ?? 'critic';
      baseRecord.error = null;
      const saved = this.store.saveRun(baseRecord);
      this.broadcast({
        type: 'run.event',
        projectId: params.project.id,
        ref: canonicalRef,
        ...parsed,
        gantryEvent: parsed,
        run: saved,
      });
      this.broadcast({
        type: 'run.finished',
        projectId: params.project.id,
        ref: canonicalRef,
        ...parsed,
        gantryEvent: parsed,
        run: saved,
      });
      this.broadcast({ type: 'board.changed', projectId: params.project.id });
      return saved;
    }

    const rawError =
      parsed && parsed.error && typeof parsed.error === 'object'
        ? (parsed.error as Record<string, unknown>)
        : {
            code: 'pull-request-failed',
            message: result.stderr.trim() || result.stdout.trim() || `approve exited with ${result.exitCode}`,
          };
    const errorPayload = normaliseErrorCode(rawError);
    baseRecord.status = 'ready-for-approval';
    baseRecord.derivedPhase = 'ready-for-approval';
    baseRecord.error = errorPayload;
    const saved = this.store.saveRun(baseRecord);
    this.broadcast({
      type: 'run.event',
      projectId: params.project.id,
      ref: canonicalRef,
      error: errorPayload,
      run: saved,
    });
    this.broadcast({ type: 'board.changed', projectId: params.project.id });
    return saved;
  }

  public async markPullRequestClosed(params: {
    project: RegisteredProject;
    ref: string;
  }): Promise<HarnessRunRecord> {
    const canonicalRef = normaliseIssueRef(params.ref);
    const stored = this.findStoredRun(params.project.id, canonicalRef);
    if (!stored) {
      throw new RunSupervisorError(404, 'run-not-found', `Run não encontrada para ${canonicalRef}.`);
    }
    const worktree =
      stored.worktree ??
      (stored.branch ? expectedWorktreePath(params.project.path, stored.branch) : null);
    removeLocalWorktree(params.project.path, worktree);

    stored.worktree = null;
    stored.lane = null;
    stored.prState = 'closed';
    stored.status = 'stopped';
    stored.derivedPhase = 'stopped';
    stored.pause = null;
    stored.pausedReason = null;
    stored.pausedChoices = null;
    const saved = this.store.saveRun(stored);
    this.broadcast({
      type: 'run.event',
      projectId: params.project.id,
      ref: canonicalRef,
      event: 'pr-closed',
      run: saved,
    });
    this.broadcast({ type: 'board.changed', projectId: params.project.id });
    return saved;
  }

  public async reopenPullRequest(params: {
    project: RegisteredProject;
    ref: string;
  }): Promise<HarnessRunRecord> {
    const canonicalRef = normaliseIssueRef(params.ref);
    const stored = this.findStoredRun(params.project.id, canonicalRef);
    if (!stored) {
      throw new RunSupervisorError(404, 'run-not-found', `Run não encontrada para ${canonicalRef}.`);
    }
    stored.lane = null;
    stored.prState = 'reopened';
    stored.status = 'ready-for-approval';
    stored.derivedPhase = 'ready-for-approval';
    stored.error = null;
    const saved = this.store.saveRun(stored);
    this.broadcast({
      type: 'run.event',
      projectId: params.project.id,
      ref: canonicalRef,
      event: 'pr-reopened',
      run: saved,
    });
    this.broadcast({ type: 'board.changed', projectId: params.project.id });
    return saved;
  }

  private async inspectPullRequestState(
    repoRoot: string,
    run: HarnessRunRecord,
  ): Promise<'open' | 'closed' | 'merged' | null> {
    if (!ghSupportsPrStateInspection()) return null;
    const target = run.prUrl || run.branch;
    if (!target) return null;
    try {
      const res = await runCommand(['gh', 'pr', 'view', target, '--json', 'state'], {
        cwd: repoRoot,
        env: process.env,
        timeoutMs: 3000,
      });
      if (res.exitCode !== 0) return null;
      const out = res.stdout.trim();
      if (!out) return null;
      try {
        const parsed = JSON.parse(out) as Record<string, unknown>;
        const state = typeof parsed.state === 'string' ? parsed.state.toUpperCase() : '';
        if (state === 'CLOSED') return 'closed';
        if (state === 'OPEN' || state === 'REOPENED') return 'open';
        if (state === 'MERGED') return 'merged';
      } catch {
        const upper = out.toUpperCase();
        if (upper === 'CLOSED') return 'closed';
        if (upper === 'OPEN' || upper === 'REOPENED') return 'open';
        if (upper === 'MERGED') return 'merged';
      }
    } catch {
      // ignore
    }
    return null;
  }

  public async reattachProject(
    project: RegisteredProject,
    boardSnapshot?: BoardSnapshot,
  ): Promise<HarnessRunRecord[]> {
    return this.syncProjectWithTarget(project, boardSnapshot);
  }

  public async syncProjectWithTarget(
    project: RegisteredProject,
    boardSnapshot?: BoardSnapshot,
  ): Promise<HarnessRunRecord[]> {
    const board = boardSnapshot ?? (await readBoard(project.path, this.homeDir));
    const doneRefs = new Set(
      board.issues.filter((issue) => issue.status === 'done').map((issue) => normaliseIssueRef(issue.ref)),
    );
    let changed = false;

    // 1. Clean up any Run whose Issue is now done on the target branch
    const storedRuns = this.store.listRuns(project.id);
    const packRecords = listPackRunRecords(project.path);
    const candidateDoneRefs = new Set<string>([
      ...doneRefs,
      ...storedRuns.filter((r) => doneRefs.has(normaliseIssueRef(r.ref))).map((r) => normaliseIssueRef(r.ref)),
      ...packRecords.filter((p) => doneRefs.has(normaliseIssueRef(p.ref))).map((p) => normaliseIssueRef(p.ref)),
    ]);

    for (const ref of candidateDoneRefs) {
      if (!doneRefs.has(ref)) continue;
      if (this.findActiveEntry(project.id, ref)) continue;
      const stored = this.store.getRun(project.id, ref);
      const pack = packRecords.find((p) => normaliseIssueRef(p.ref) === ref);
      const branch =
        stored?.branch ?? pack?.branch ?? renderExpectedIssueBranch(project.path, ref);
      const worktree =
        stored?.worktree ?? (branch ? expectedWorktreePath(project.path, branch) : null);

      const hasWorktree = Boolean(worktree && fs.existsSync(worktree));
      const hasBranch = Boolean(branch && gitBranchExists(project.path, branch));

      if (hasWorktree) {
        removeLocalWorktree(project.path, worktree);
        changed = true;
      }
      if (hasBranch) {
        removeLocalBranch(project.path, branch);
        changed = true;
      }
      if (pack) {
        deletePackRunRecord(project.path, ref);
        changed = true;
      }
      if (stored) {
        this.store.deleteRun(project.id, ref);
        changed = true;
      }
    }

    // 2. Adopt or update interrupted/finished Runs from .git/gantry-cli/*.json records
    for (const pack of listPackRunRecords(project.path)) {
      const canonicalRef = normaliseIssueRef(pack.ref);
      if (doneRefs.has(canonicalRef)) continue;
      const active = this.findActiveEntry(project.id, canonicalRef);
      if (active && !active.exited) {
        this.syncPackPhase(active, false);
        continue;
      }

      const expectedBranch = renderExpectedIssueBranch(project.path, canonicalRef);
      if (expectedBranch && pack.branch !== expectedBranch) {
        continue;
      }
      if (!gitBranchExists(project.path, pack.branch)) {
        continue;
      }

      const wtPath = expectedWorktreePath(project.path, pack.branch);
      const wtExists = fs.existsSync(wtPath) && fs.statSync(wtPath).isDirectory();
      const existing = this.store.getRun(project.id, canonicalRef);

      if (!wtExists && existing?.prState !== 'closed' && existing?.prState !== 'reopened') {
        continue;
      }

      const kind: HarnessRunKind =
        pack.specPath || pack.issuePath || existing?.kind === 'plan' ? 'plan' : 'issue';
      const mappedLane: ExecutionLane =
        phaseToExecutionLane(pack.phase, kind === 'plan' ? 'plan' : 'implement') ?? 'implement';
      const isReady = pack.phase.trim().toLowerCase() === 'ready';

      const nextStatus: HarnessRunRecord['status'] =
        existing?.prState === 'closed'
          ? 'stopped'
          : existing?.prState === 'reopened'
            ? 'ready-for-approval'
            : isReady
              ? existing?.status === 'approved-pending-merge'
                ? 'approved-pending-merge'
                : 'ready-for-approval'
              : 'stopped';

      const nextDerivedPhase: HarnessRunRecord['derivedPhase'] =
        nextStatus === 'approved-pending-merge'
          ? 'approved-pending-merge'
          : nextStatus === 'ready-for-approval'
            ? 'ready-for-approval'
            : 'stopped';

      const nextLane: ExecutionLane | null =
        existing?.prState === 'closed' || existing?.prState === 'reopened' ? null : mappedLane;

      const issueTitle =
        (wtExists && pack.issuePath ? readIssueTitleFromWorktree(wtPath, pack.issuePath) : null) ??
        existing?.issueTitle ??
        null;

      const needsAdoption =
        !existing ||
        existing.status === 'running' ||
        existing.status === 'paused' ||
        existing.childPid !== null ||
        existing.packPhase !== pack.phase ||
        existing.lane !== nextLane ||
        existing.status !== nextStatus ||
        existing.derivedPhase !== nextDerivedPhase ||
        existing.issueTitle !== issueTitle;

      if (needsAdoption) {
        const now = new Date().toISOString();
        const adopted: HarnessRunRecord = {
          runId: existing?.runId ?? `run-${crypto.randomUUID().slice(0, 8)}`,
          projectId: project.id,
          ref: canonicalRef,
          slug: canonicalRef.split('#')[0] ?? canonicalRef,
          kind,
          status: nextStatus,
          childPid: null,
          pid: null,
          childHandle: null,
          lane: nextLane,
          packPhase: pack.phase,
          branch: pack.branch,
          worktree: wtExists ? wtPath : null,
          pushed: existing?.pushed ?? false,
          pause: null,
          pausedReason: null,
          pausedChoices: null,
          terminalEvent:
            nextStatus === 'approved-pending-merge'
              ? 'pull-request'
              : nextStatus === 'ready-for-approval'
                ? 'ready-for-approval'
                : 'stopped',
          error:
            existing?.error &&
            existing.error.code !== 'unexpected-exit' &&
            existing.error.code !== 'unanswered-pause-exit'
              ? existing.error
              : null,
          prUrl: existing?.prUrl ?? null,
          prState: existing?.prState ?? null,
          createdCommit: existing?.createdCommit,
          derivedPhase: nextDerivedPhase,
          specPath: pack.specPath ?? existing?.specPath ?? null,
          issuePath: pack.issuePath ?? existing?.issuePath ?? null,
          issueTitle,
          stdoutLines: existing?.stdoutLines ?? [],
          stderrText: existing?.stderrText ?? '',
          exitCode: existing?.exitCode ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        this.store.saveRun(adopted);
        changed = true;
      }
    }

    // 3. Check PR status for approved-pending-merge or closed PRs
    for (const run of this.store.listRuns(project.id)) {
      if (doneRefs.has(normaliseIssueRef(run.ref))) continue;
      if (run.status === 'approved-pending-merge' || run.prState === 'closed') {
        const prState = await this.inspectPullRequestState(project.path, run);
        if (prState === 'closed' && run.prState !== 'closed') {
          await this.markPullRequestClosed({ project, ref: run.ref });
          changed = true;
        } else if (prState === 'open' && run.prState === 'closed') {
          await this.reopenPullRequest({ project, ref: run.ref });
          changed = true;
        }
      }
    }

    if (changed) {
      this.broadcast({ type: 'board.changed', projectId: project.id });
    }

    return this.listRuns(project.id);
  }

  public getRun(projectId: string, ref: string): HarnessRunRecord | null {
    const entry = this.findActiveEntry(projectId, ref);
    if (entry && !entry.exited) {
      this.syncPackPhase(entry, false);
      return entry.record;
    }
    return this.findStoredRun(projectId, ref);
  }

  public listRuns(projectId: string): HarnessRunRecord[] {
    for (const entry of this.active.values()) {
      if (entry.projectId === projectId && !entry.exited) {
        this.syncPackPhase(entry, false);
      }
    }
    return this.store.listRuns(projectId);
  }

  public closeAll(): void {
    this.shuttingDown = true;
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    for (const entry of this.active.values()) {
      if (entry.pollTimer) {
        clearInterval(entry.pollTimer);
        entry.pollTimer = null;
      }
      if (!entry.exited) {
        entry.record.childPid = null;
        entry.record.pid = null;
        entry.record.childHandle = null;
        if (entry.record.status === 'running' || entry.record.status === 'paused') {
          entry.record.status = 'stopped';
          entry.record.derivedPhase = 'stopped';
          entry.record.pause = null;
          entry.record.pausedReason = null;
          entry.record.pausedChoices = null;
          this.store.saveRun(entry.record);
        }
        try {
          entry.child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }
    this.active.clear();
  }
}
