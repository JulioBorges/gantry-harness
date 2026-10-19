export type PackResolutionKind = 'pinned' | 'global' | 'path' | 'none';

export interface BoardIssue {
  ref: string;
  spec: string;
  number: number;
  title: string;
  status: string;
  path: string;
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

export type IssueCardPhase = 'ready-to-agent' | 'blocked' | 'done';

export const BOARD_LANES = ['specs', 'issues', 'plan', 'implement', 'review', 'critic', 'done'] as const;

export type BoardLane = (typeof BOARD_LANES)[number];

export type ExecutionLane = 'plan' | 'implement' | 'review' | 'critic';

export interface IssueRunOverlay {
  ref: string;
  lane: ExecutionLane;
  operatorWaiting: boolean;
  runId: string;
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
};

export const NO_PACK_EXPLANATION =
  'Não há Gantry neste projeto nem uma instalação global. Configure o pack neste projeto ou em Configurações → Gantry.';

export function issuePhase(issue: Pick<BoardIssue, 'status' | 'frontierBlocked'>): IssueCardPhase {
  if (issue.status === 'done') return 'done';
  if (issue.frontierBlocked) return 'blocked';
  return 'ready-to-agent';
}

const EXECUTION_COLUMNS: Record<string, ExecutionLane> = {
  Plan: 'plan',
  Implement: 'implement',
  Review: 'review',
  Critic: 'critic',
  Integrate: 'critic',
};

export function issueLane(issue: Pick<BoardIssue, 'status' | 'ref'>, overlays: IssueRunOverlay[]): BoardLane {
  if (issue.status === 'done') return 'done';
  const overlay = [...overlays].reverse().find((item) => item.ref === issue.ref);
  return overlay?.lane ?? 'issues';
}

export function overlaysFromKanban(
  runs: Array<{
    runId: string;
    finished: boolean;
    columns: Record<string, Array<{ ref: string; operatorWaiting?: boolean }>>;
  }>,
): IssueRunOverlay[] {
  const overlays: IssueRunOverlay[] = [];
  for (const run of runs) {
    if (run.finished) continue;
    for (const [column, lane] of Object.entries(EXECUTION_COLUMNS)) {
      for (const item of run.columns[column] ?? []) {
        overlays.push({
          ref: item.ref,
          lane,
          operatorWaiting: item.operatorWaiting === true,
          runId: run.runId,
        });
      }
    }
  }
  return overlays;
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
  if (data.resolution !== 'pinned' && data.resolution !== 'path' && data.resolution !== 'none') {
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
