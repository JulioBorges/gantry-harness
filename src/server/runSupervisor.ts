import { spawn } from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import {
  isSetupRefusalError,
  phaseToExecutionLane,
  type ExecutionLane,
  type GantryErrorPayload,
  type HarnessRunKind,
  type HarnessRunPause,
  type HarnessRunRecord,
} from '../boardModel.js';
import type { RegisteredProject } from '../types.js';
import {
  buildPackCommand,
  normaliseIssueRef,
  readPackRunRecord,
  resolvePackExecutable,
} from './gantryCli.js';
import type { HarnessStateStore } from './stateStore.js';

interface SupervisedChild {
  projectId: string;
  repoPath: string;
  ref: string;
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

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class RunSupervisor {
  private readonly active = new Map<string, SupervisedChild>();
  private readonly store: HarnessStateStore;
  private readonly broadcast: (payload: Record<string, unknown>) => void;
  private readonly homeDir: string;

  constructor(options: {
    store: HarnessStateStore;
    broadcast: (payload: Record<string, unknown>) => void;
    homeDir?: string;
  }) {
    this.store = options.store;
    this.broadcast = options.broadcast;
    this.homeDir = options.homeDir ?? os.homedir();
  }

  private key(projectId: string, ref: string): string {
    return `${projectId}:${normaliseIssueRef(ref)}`;
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
    const pack = readPackRunRecord(entry.repoPath, entry.ref);
    if (!pack) return false;
    const nextLane = phaseToExecutionLane(pack.phase, entry.record.lane);
    const phaseChanged = pack.phase !== entry.record.packPhase;
    const laneChanged = nextLane !== entry.record.lane;
    const branchAdded = Boolean(pack.branch && !entry.record.branch);
    if (!phaseChanged && !laneChanged && !branchAdded) {
      return false;
    }
    entry.record.packPhase = pack.phase;
    entry.record.lane = nextLane;
    if (pack.branch && !entry.record.branch) {
      entry.record.branch = pack.branch;
    }
    if (pack.specPath) {
      entry.record.specPath = pack.specPath;
    }
    if (pack.issuePath) {
      entry.record.issuePath = pack.issuePath;
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
      if (reason === 'plan-approval' || reason === 'plan-dirty') {
        entry.record.lane = 'plan';
      } else {
        entry.record.lane = phaseToExecutionLane(entry.record.packPhase, entry.record.lane ?? 'implement');
      }
      const pauseObj: HarnessRunPause = {
        reason,
        choices,
        branch: entry.record.branch ?? '',
        worktree: entry.record.worktree ?? '',
        pushed: entry.record.pushed,
        ...(typeof parsed.prompt === 'string' ? { prompt: parsed.prompt } : {}),
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

    if (parsed.event === 'pull-request') {
      if (typeof parsed.branch === 'string') entry.record.branch = parsed.branch;
      if (typeof parsed.worktree === 'string') entry.record.worktree = parsed.worktree;
      entry.record.pushed = Boolean(parsed.pushed);
      entry.record.prUrl = typeof parsed.url === 'string' ? parsed.url : null;
      entry.record.status = 'approved-pending-merge';
      entry.record.terminalEvent = 'pull-request';
      entry.record.pause = null;
      entry.record.pausedReason = null;
      entry.record.pausedChoices = null;
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
      const rawError = parsed.error as Record<string, unknown>;
      const code = typeof rawError.code === 'string' ? rawError.code : 'unknown-error';
      const reason = typeof rawError.reason === 'string' ? rawError.reason : undefined;
      const openBlockers = Array.isArray(rawError.openBlockers)
        ? rawError.openBlockers.filter((item): item is string => typeof item === 'string')
        : undefined;
      const errorPayload: GantryErrorPayload = {
        ...rawError,
        code,
        ...(reason ? { reason } : {}),
        ...(openBlockers ? { openBlockers } : {}),
      };
      entry.record.status = 'failed';
      entry.record.error = errorPayload;
      entry.record.pause = null;
      entry.record.pausedReason = null;
      entry.record.pausedChoices = null;
      if (!entry.record.worktree && isSetupRefusalError(errorPayload)) {
        entry.record.lane = null;
        entry.record.derivedPhase = code === 'open-blocker' ? 'blocked' : 'ready-to-agent';
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

  public async startRun(params: {
    project: RegisteredProject;
    ref: string;
    kind?: HarnessRunKind;
  }): Promise<HarnessRunRecord> {
    const rawRef = params.ref.trim();
    if (!rawRef) {
      throw new RunSupervisorError(400, 'issue-missing', 'A referência da Issue é obrigatória.');
    }
    const kind: HarnessRunKind = params.kind ?? (rawRef.includes('#') ? 'issue' : 'plan');
    const ref = kind === 'issue' ? normaliseIssueRef(rawRef) : rawRef;
    const mapKey = this.key(params.project.id, ref);

    const existingActive = this.active.get(mapKey);
    if (existingActive && !existingActive.exited) {
      throw new RunSupervisorError(409, 'run-already-active', `Run ${ref} já está em execução.`);
    }

    const resolved = resolvePackExecutable(params.project.path, this.homeDir);
    if (resolved.kind === 'none') {
      throw new RunSupervisorError(400, 'pack-unavailable', resolved.explanation);
    }

    const command = buildPackCommand(resolved, params.project.path, 'execute', ref);
    const now = new Date().toISOString();
    const initialLane: ExecutionLane = kind === 'plan' ? 'plan' : 'implement';
    const slug = ref.includes('#') ? ref.split('#')[0] : ref;

    const child = spawn(command[0], command.slice(1), {
      cwd: params.project.path,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    const pid = child.pid ?? null;
    const initialRecord: HarnessRunRecord = {
      runId: `run-${crypto.randomUUID().slice(0, 8)}`,
      projectId: params.project.id,
      ref,
      slug,
      kind,
      status: 'running',
      childPid: pid,
      pid,
      childHandle: pid ? `pid:${pid}` : null,
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

    const entry: SupervisedChild = {
      projectId: params.project.id,
      repoPath: params.project.path,
      ref,
      child,
      record: this.store.saveRun(initialRecord),
      stdoutBuffer: '',
      pollTimer: null,
      waiters: [],
      exited: false,
    };

    this.active.set(mapKey, entry);

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
      this.active.delete(mapKey);
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
      this.active.delete(mapKey);

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

    // Wait for the initial worktree event, pause, setup error, or child exit
    await this.waitForInitialEvent(entry, 2000);
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

  public async answerPause(params: {
    projectId: string;
    ref: string;
    choice: string;
  }): Promise<HarnessRunRecord> {
    const canonicalRef = params.ref.includes('#') ? normaliseIssueRef(params.ref) : params.ref.trim();
    const mapKey = this.key(params.projectId, canonicalRef);
    const entry = this.active.get(mapKey);
    const stored = entry?.record ?? this.store.getRun(params.projectId, canonicalRef);

    if (!stored) {
      throw new RunSupervisorError(404, 'run-not-found', `Run não encontrada para ${canonicalRef}.`);
    }

    if (!entry || entry.exited || entry.record.status !== 'paused' || !entry.record.pause) {
      throw new RunSupervisorError(
        409,
        'no-pause-outstanding',
        `Run ${canonicalRef} não aguarda resposta de pausa.`,
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
        `Entrada do processo da Run ${canonicalRef} não está disponível.`,
      );
    }

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

    await this.waitForNextActivity(entry, 250);
    return entry.record;
  }

  public getRun(projectId: string, ref: string): HarnessRunRecord | null {
    const canonicalRef = ref.includes('#') ? normaliseIssueRef(ref) : ref.trim();
    const entry = this.active.get(this.key(projectId, canonicalRef));
    if (entry && !entry.exited) {
      this.syncPackPhase(entry, false);
      return entry.record;
    }
    return this.store.getRun(projectId, canonicalRef);
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
    for (const entry of this.active.values()) {
      if (entry.pollTimer) {
        clearInterval(entry.pollTimer);
        entry.pollTimer = null;
      }
      if (!entry.exited) {
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
