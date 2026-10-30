export type PackResolutionKind = 'pinned' | 'global' | 'path' | 'none';

export interface BoardIssue {
  ref: string;
  spec: string;
  number: number;
  title: string;
  status: string;
  path?: string;
  synthetic?: boolean;
  frontierBlocked: boolean;
  openBlockers: string[];
}

export interface BoardSpec {
  slug: string;
  path: string;
  executable: boolean;
}

export interface BoardSnapshot {
  resolution: PackResolutionKind;
  executionEnabled: boolean;
  explanation: string | null;
  issues: BoardIssue[];
  specs: BoardSpec[];
  frontier: string[];
}

export type IssueCardPhase =
  | 'ready-to-agent'
  | 'blocked'
  | 'done'
  | 'plan'
  | 'implement'
  | 'review'
  | 'critic'
  | 'paused'
  | 'stopped'
  | 'failed'
  | 'ready-for-approval'
  | 'approved-pending-merge';

export const BOARD_LANES = ['specs', 'issues', 'plan', 'implement', 'review', 'critic', 'done'] as const;

export type BoardLane = (typeof BOARD_LANES)[number];

export type ExecutionLane = 'plan' | 'implement' | 'review' | 'critic';

export type GantryPauseReason = 'plan-approval' | 'corrections-exhausted' | 'plan-dirty' | (string & {});

export interface GantryWorktreeEvent {
  event: 'worktree';
  branch: string;
  worktree: string;
  pushed: boolean;
}

export interface GantryPauseEvent {
  event: 'pause';
  reason: GantryPauseReason;
  choices: string[];
  branch: string;
  worktree: string;
  pushed: boolean;
  prompt?: string;
}

export interface GantryStoppedEvent {
  event: 'stopped';
  branch: string;
  worktree: string;
  pushed: boolean;
}

export interface GantryReadyForApprovalEvent {
  event: 'ready-for-approval';
  branch: string;
  worktree: string;
  pushed: boolean;
}

export interface GantryPullRequestEvent {
  event: 'pull-request';
  branch: string;
  target: string;
  worktree: string;
  pushed: boolean;
  createdCommit: boolean;
  url: string;
}

export interface GantryRejectedOrDiscardedEvent {
  event: 'rejected' | 'discarded';
  branch: string;
  pushed: boolean;
}

export interface GantryErrorPayload {
  code: string;
  reason?: string;
  openBlockers?: string[];
  repository?: string;
  message?: string;
  [key: string]: unknown;
}

export interface GantryErrorEvent {
  error: GantryErrorPayload;
}

export type GantryEvent =
  | GantryWorktreeEvent
  | GantryPauseEvent
  | GantryStoppedEvent
  | GantryReadyForApprovalEvent
  | GantryPullRequestEvent
  | GantryRejectedOrDiscardedEvent
  | GantryErrorEvent;

export type HarnessRunKind = 'issue' | 'plan';

export type HarnessRunStatus =
  | 'running'
  | 'paused'
  | 'stopped'
  | 'ready-for-approval'
  | 'approved-pending-merge'
  | 'failed'
  | 'rejected'
  | 'discarded';

export type TerminalEventKind =
  | 'stopped'
  | 'ready-for-approval'
  | 'rejected'
  | 'discarded'
  | 'pull-request';

export interface HarnessRunPause {
  reason: GantryPauseReason;
  choices: string[];
  branch: string;
  worktree: string;
  pushed: boolean;
  prompt?: string;
  specPath?: string | null;
  issuePath?: string | null;
}

export interface HarnessRunRecord {
  runId: string;
  projectId: string;
  ref: string;
  slug: string;
  kind: HarnessRunKind;
  status: HarnessRunStatus;
  childPid: number | null;
  pid: number | null;
  childHandle: string | null;
  lane: ExecutionLane | null;
  packPhase: string | null;
  branch: string | null;
  worktree: string | null;
  pushed: boolean;
  pause: HarnessRunPause | null;
  pausedReason: string | null;
  pausedChoices: string[] | null;
  terminalEvent: TerminalEventKind | null;
  error: GantryErrorPayload | null;
  prUrl: string | null;
  prState?: 'open' | 'closed' | 'reopened' | 'merged' | null;
  createdCommit?: boolean;
  derivedPhase: IssueCardPhase;
  specPath?: string | null;
  issuePath?: string | null;
  issueTitle?: string | null;
  stdoutLines?: string[];
  stderrText?: string;
  exitCode?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRunOverlay {
  ref: string;
  lane: BoardLane;
  operatorWaiting: boolean;
  runId: string;
  status?: HarnessRunStatus;
  phase?: IssueCardPhase;
  branch?: string | null;
  worktree?: string | null;
  pause?: HarnessRunPause | null;
  terminalEvent?: TerminalEventKind | null;
  error?: GantryErrorPayload | null;
  prUrl?: string | null;
}

export const LANE_LABEL: Record<BoardLane, string> = {
  specs: 'Specs',
  issues: 'Issues',
  plan: 'Plan',
  implement: 'Implement',
  review: 'Review',
  critic: 'Critic',
  done: 'Done',
};

export const PHASE_LABEL: Record<IssueCardPhase, string> = {
  'ready-to-agent': 'ready to agent',
  blocked: 'blocked',
  done: 'done',
  plan: 'plan',
  implement: 'implement',
  review: 'review',
  critic: 'critic',
  paused: 'paused',
  stopped: 'stopped',
  failed: 'failed',
  'ready-for-approval': 'ready for approval',
  'approved-pending-merge': 'approved pending merge',
};

export const NO_PACK_EXPLANATION =
  'Não há Gantry neste projeto nem uma instalação global. Configure o pack neste projeto ou em Configurações → Gantry.';

export function phaseToExecutionLane(
  phaseOrRole: string | null | undefined,
  fallback: ExecutionLane | null = null,
): ExecutionLane | null {
  if (!phaseOrRole) return fallback;
  const normalized = phaseOrRole.trim().toLowerCase();
  if (normalized === 'plan' || normalized === 'plan-approval') return 'plan';
  if (normalized === 'implement' || normalized === 'checks') return 'implement';
  if (normalized === 'review') return 'review';
  if (normalized === 'critic' || normalized === 'integrate') return 'critic';
  if (normalized === 'ready' || normalized === 'ready-for-approval') return fallback ?? 'critic';
  return fallback;
}

export function isSetupRefusalError(error: GantryErrorPayload | null | undefined): boolean {
  if (!error) return false;
  const candidates = [error.code, error.reason].filter((v): v is string => typeof v === 'string');
  return candidates.some(
    (code) =>
      code === 'open-blocker' ||
      code === 'branch-exists' ||
      code === 'spec-or-issue-exists' ||
      code === 'setup-invalid' ||
      code === 'pack-unreadable' ||
      code === 'issue-missing' ||
      code === 'spec-missing' ||
      code === 'role-command-missing' ||
      code === 'checks-invalid' ||
      code === 'target-missing',
  );
}

export function issuePhase(
  issue: Pick<BoardIssue, 'status' | 'frontierBlocked' | 'synthetic'>,
  overlay?: Pick<IssueRunOverlay, 'phase' | 'status'> | null,
  run?: Pick<HarnessRunRecord, 'status' | 'derivedPhase' | 'error' | 'worktree' | 'prState'> | null,
): IssueCardPhase {
  if (issue.status === 'done') return 'done';
  if (overlay?.phase) return overlay.phase;
  if (run) {
    if (run.prState === 'closed') return 'stopped';
    if (run.prState === 'reopened') return 'ready-for-approval';
    if (run.status === 'stopped') return 'stopped';
    if (run.status === 'ready-for-approval') return 'ready-for-approval';
    if (run.status === 'approved-pending-merge') return 'approved-pending-merge';
    if (run.status === 'paused') return 'paused';
    if (run.status === 'running') return run.derivedPhase;
    if (run.status === 'failed' && (issue.synthetic || !isSetupRefusalError(run.error) || Boolean(run.worktree))) {
      return 'failed';
    }
  }
  if (issue.frontierBlocked) return 'blocked';
  return 'ready-to-agent';
}

export function issueLane(issue: Pick<BoardIssue, 'status' | 'ref'>, overlays: IssueRunOverlay[]): BoardLane {
  if (issue.status === 'done') return 'done';
  const overlay = [...overlays].reverse().find((item) => item.ref === issue.ref);
  return overlay?.lane ?? 'issues';
}

function isAbandonedRun(run: Pick<HarnessRunRecord, 'status'>): boolean {
  return run.status === 'discarded' || run.status === 'rejected';
}

export function isRetiredRun(run: Pick<HarnessRunRecord, 'status' | 'prState'>): boolean {
  return isAbandonedRun(run) || run.prState === 'closed';
}

export function overlaysFromRuns(runs: HarnessRunRecord[]): IssueRunOverlay[] {
  const overlays: IssueRunOverlay[] = [];
  for (const run of runs) {
    if (isRetiredRun(run)) continue;
    if (run.status === 'failed' && isSetupRefusalError(run.error) && !run.worktree) {
      continue;
    }
    const executionLane = run.lane ?? phaseToExecutionLane(run.packPhase, run.kind === 'plan' ? 'plan' : 'implement') ?? 'implement';
    const lane = run.prState !== 'reopened' && (run.status === 'running' || run.status === 'paused') ? executionLane : 'issues';
    const phase: IssueCardPhase =
      run.prState === 'reopened' ? 'ready-for-approval' :
      run.status === 'paused'
        ? 'paused'
        : run.status === 'stopped'
          ? 'stopped'
          : run.status === 'ready-for-approval'
            ? 'ready-for-approval'
            : run.status === 'approved-pending-merge'
              ? 'approved-pending-merge'
              : run.status === 'failed'
                ? 'failed'
                : executionLane;
    overlays.push({
      ref: run.ref,
      lane,
      operatorWaiting: run.status === 'paused',
      runId: run.runId,
      status: run.status,
      phase,
      branch: run.branch,
      worktree: run.worktree,
      pause: run.pause,
      terminalEvent: run.terminalEvent,
      error: run.error,
      prUrl: run.prUrl,
    });
  }
  return overlays;
}

// Retained Issue worktrees remain useful for recovery even after the process stops.
// Plan Runs have their own lifecycle and do not become Issue Runs merely by acquiring a numbered ref.
export function issueWorktreeRuns(
  runs: HarnessRunRecord[],
  projectId: string | null,
  checkoutPath?: string,
): HarnessRunRecord[] {
  return runs.filter((run) =>
    run.projectId === projectId && run.kind === 'issue' && run.worktree &&
    run.worktree !== checkoutPath && !isRetiredRun(run),
  );
}

export function mergeBoardWithPlanRuns(
  board: BoardSnapshot,
  runs: HarnessRunRecord[],
): BoardSnapshot {
  if (!runs.length) return board;
  let specs = board.specs;
  let issues = board.issues;
  for (const run of runs) {
    if (run.kind !== 'plan') continue;
    if (run.status === 'rejected' || run.status === 'discarded') continue;
    if (!run.worktree && !run.error) continue;

    if (run.slug && !specs.some((item) => item.slug === run.slug)) {
      specs = [
        ...specs,
        {
          slug: run.slug,
          path: run.specPath ?? `.scratch/${run.slug}/spec.md`,
          executable: false,
        },
      ];
    }

    const effectiveRef = run.ref.includes('#') ? run.ref : `${run.slug}#01`;
    if (!issues.some((item) => item.ref === effectiveRef)) {
      const numPart = Number(effectiveRef.split('#')[1] ?? 1);
      const number = Number.isInteger(numPart) && numPart > 0 ? numPart : 1;
      issues = [
        ...issues,
        {
          ref: effectiveRef,
          spec: run.slug,
          number,
          title: run.issueTitle ?? run.slug,
          status: 'ready-for-agent',
          path: run.issuePath ?? undefined,
          synthetic: true,
          frontierBlocked: false,
          openBlockers: [],
        },
      ];
    }
  }
  if (specs === board.specs && issues === board.issues) return board;
  return {
    ...board,
    specs,
    issues,
  };
}

export function orderedIssues(board: BoardSnapshot): BoardIssue[] {
  const rank = new Map(board.frontier.map((ref, index) => [ref, index]));
  return [...board.issues].sort((left, right) => (rank.get(left.ref) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.ref) ?? Number.MAX_SAFE_INTEGER));
}

export function emptyBoard(resolution: PackResolutionKind, explanation: string | null): BoardSnapshot {
  return {
    resolution,
    executionEnabled: false,
    explanation,
    issues: [],
    specs: [],
    frontier: [],
  };
}

export function unavailableBoard(explanation = 'O quadro não pôde ser lido.'): BoardSnapshot {
  return emptyBoard('none', explanation);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function parsePackBoard(value: unknown): Pick<BoardSnapshot, 'issues' | 'specs' | 'frontier'> {
  if (!value || typeof value !== 'object') throw new Error('board output must be a JSON object');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.issues)) throw new Error('board issues must be an array');
  if (!Array.isArray(record.specs)) throw new Error('board specs must be an array');
  if (!Array.isArray(record.frontier)) throw new Error('board frontier must be an array');
  const issues = record.issues.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`issues[${index}] must be an object`);
    const issue = entry as Record<string, unknown>;
    if (typeof issue.number !== 'number' || !Number.isInteger(issue.number)) {
      throw new Error(`issues[${index}].number must be an integer`);
    }
    if (typeof issue.frontierBlocked !== 'boolean') {
      throw new Error(`issues[${index}].frontierBlocked must be a boolean`);
    }
    if (!Array.isArray(issue.openBlockers) || issue.openBlockers.some((blocker) => typeof blocker !== 'string')) {
      throw new Error(`issues[${index}].openBlockers must be an array of strings`);
    }
    return {
      ref: requireString(issue.ref, `issues[${index}].ref`),
      spec: requireString(issue.spec, `issues[${index}].spec`),
      number: issue.number,
      title: requireString(issue.title, `issues[${index}].title`),
      status: requireString(issue.status, `issues[${index}].status`),
      path: requireString(issue.path, `issues[${index}].path`),
      frontierBlocked: issue.frontierBlocked,
      openBlockers: issue.openBlockers,
    };
  });
  const specs = record.specs.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`specs[${index}] must be an object`);
    const spec = entry as Record<string, unknown>;
    if (typeof spec.executable !== 'boolean') throw new Error(`specs[${index}].executable must be a boolean`);
    return {
      slug: requireString(spec.slug, `specs[${index}].slug`),
      path: requireString(spec.path, `specs[${index}].path`),
      executable: spec.executable,
    };
  });
  const frontier = record.frontier.map((entry, index) => requireString(entry, `frontier[${index}]`));
  return { issues, specs, frontier };
}

export function coerceBoard(value: unknown): BoardSnapshot {
  if (!value || typeof value !== 'object') return unavailableBoard();
  const data = value as Partial<BoardSnapshot>;
  if (data.resolution !== 'pinned' && data.resolution !== 'global' && data.resolution !== 'path' && data.resolution !== 'none') {
    return unavailableBoard();
  }
  return {
    resolution: data.resolution,
    executionEnabled: data.executionEnabled === true,
    explanation: typeof data.explanation === 'string' ? data.explanation : data.explanation === null ? null : null,
    issues: Array.isArray(data.issues) ? data.issues : [],
    specs: Array.isArray(data.specs) ? data.specs : [],
    frontier: Array.isArray(data.frontier) ? data.frontier : [],
  };
}

export function runErrorMessage(error: GantryErrorPayload): string {
  const messages: Record<string, string> = {
    'open-blocker': 'Esta Issue tem dependências pendentes. Conclua os bloqueadores antes de executar.',
    'branch-exists': 'A branch desta Issue já existe. Retome a Run existente ou revise a branch antes de executar.',
    'spec-or-issue-exists': 'A Spec ou a Issue já existe. Revise os arquivos do projeto antes de planejar novamente.',
    'setup-invalid': 'A configuração do Gantry precisa ser corrigida nas configurações do projeto.',
    'role-command-missing': 'Falta configurar o comando de um papel do pipeline nas configurações do projeto.',
    'checks-invalid': 'Os checks do projeto são inválidos. Revise as configurações do projeto.',
    'target-missing': 'A branch de destino não foi encontrada. Revise as configurações Git do projeto.',
    'pack-unreadable': 'Não foi possível ler o pack do Gantry. Revise a instalação no projeto.',
    'issue-missing': 'O arquivo da Issue não foi encontrado no projeto.',
    'spec-missing': 'O arquivo da Spec não foi encontrado no projeto.',
    'pull-request-failed': 'Não foi possível abrir o PR. Verifique o acesso ao repositório e tente aprovar novamente.',
  };
  return messages[error.reason ?? ''] ?? messages[error.code] ?? 'A Run encontrou um erro. Consulte os detalhes para verificar a execução.';
}
