import React from 'react';
import {
  BOARD_LANES,
  LANE_LABEL,
  PHASE_LABEL,
  issueLane,
  issuePhase,
  orderedIssues,
  overlaysFromRuns,
  type BoardLane,
  type BoardSnapshot,
  type HarnessRunRecord,
  type IssueRunOverlay,
} from '../boardModel.js';

export function BoardView({
  board,
  hasProject,
  overlays = [],
  runs = [],
  specInteractions = {},
  issueInteractions = {},
  onRefresh,
  onOpenPath,
  onFollow,
  onRunIssue,
  onAnswerPause,
}: {
  board: BoardSnapshot | null;
  hasProject: boolean;
  overlays?: IssueRunOverlay[];
  runs?: HarnessRunRecord[];
  specInteractions?: Record<string, React.ReactNode>;
  issueInteractions?: Record<string, React.ReactNode>;
  onRefresh: () => void;
  onOpenPath?: (path: string) => void;
  onFollow?: (ref: string, runId?: string) => void;
  onRunIssue?: (ref: string) => void;
  onAnswerPause?: (ref: string, choice: string) => void;
}): React.ReactElement {
  if (!hasProject) {
    return (
      <section className="issue-board" data-testid="issue-board" aria-label="Issues e Specs">
        <div className="execution-empty">
          <strong>Abra um projeto para ver o quadro</strong>
          <p>O quadro lista Issues e Specs lidos do repositório.</p>
        </div>
      </section>
    );
  }
  if (!board) {
    return (
      <section className="issue-board" data-testid="issue-board" aria-label="Issues e Specs">
        <p>Lendo o quadro…</p>
      </section>
    );
  }

  const executionEnabled = board.executionEnabled;
  const issues = orderedIssues(board);
  const effectiveOverlays = [...overlays, ...overlaysFromRuns(runs)];
  const lanes: Record<BoardLane, React.ReactNode[]> = {
    specs: [],
    issues: [],
    plan: [],
    implement: [],
    review: [],
    critic: [],
    done: [],
  };

  for (const spec of board.specs) {
    const interaction = specInteractions[spec.slug];
    lanes.specs.push(
      <article key={spec.slug} className="board-card spec-card" data-testid={`spec-card-${spec.slug}`} data-executable="false" data-lane="specs">
        <p className="board-ref"><code>{spec.slug}</code></p>
        <h3>{spec.path}</h3>
        <p className="board-phase">non-executable</p>
        <div className="board-card-actions">
          <button type="button" data-testid={`open-spec-${spec.slug}`} onClick={() => onOpenPath?.(spec.path)}>Abrir documentação</button>
        </div>
        {interaction && <div className="board-interaction" data-testid={`spec-interaction-${spec.slug}`}>{interaction}</div>}
      </article>,
    );
  }

  for (const issue of issues) {
    const overlay = [...effectiveOverlays].reverse().find((item) => item.ref === issue.ref);
    const run = [...runs].reverse().find((item) => item.ref === issue.ref);
    const phase = issuePhase(issue, overlay, run);
    const lane = issueLane(issue, effectiveOverlays);
    const spec = board.specs.find((item) => item.slug === issue.spec);
    const interaction = issueInteractions[issue.ref];
    const running = lane === 'plan' || lane === 'implement' || lane === 'review' || lane === 'critic';
    const pause = run?.pause ?? overlay?.pause ?? null;
    const error = run?.error ?? overlay?.error ?? null;
    const worktree = run?.worktree ?? overlay?.worktree ?? null;
    const branch = run?.branch ?? overlay?.branch ?? null;
    const canStartRun =
      issue.status !== 'done' &&
      run?.status !== 'running' &&
      run?.status !== 'paused';

    lanes[lane].push(
      <article key={issue.ref} className="board-card" data-testid={`issue-card-${issue.ref}`} data-phase={phase} data-ref={issue.ref} data-lane={lane}>
        <p className="board-ref"><code>{issue.ref}</code></p>
        <h3>{issue.title}</h3>
        <p className="board-phase" data-testid={`issue-phase-${issue.ref}`}>{PHASE_LABEL[phase]}</p>
        {phase === 'blocked' && (
          <ul className="board-blockers" aria-label={`Open blockers for ${issue.ref}`}>
            {issue.openBlockers.map((blocker) => <li key={blocker} data-testid="open-blocker">{blocker}</li>)}
          </ul>
        )}
        {worktree && (
          <p className="board-worktree" data-testid={`issue-worktree-${issue.ref}`}>
            <code>{branch ? `${branch} · ${worktree}` : worktree}</code>
          </p>
        )}
        {error && (
          <div className="board-run-error" role="alert" data-testid={`run-error-${issue.ref}`}>
            <strong>{error.reason ? `${error.code} (${error.reason})` : error.code}</strong>
            {error.openBlockers && error.openBlockers.length > 0 && (
              <span>: {error.openBlockers.join(', ')}</span>
            )}
            {error.message && <p>{error.message}</p>}
          </div>
        )}
        <div className="board-card-actions">
          {spec && <button type="button" data-testid={`open-spec-${issue.ref}`} onClick={() => onOpenPath?.(spec.path)}>Abrir spec</button>}
          {canStartRun && onRunIssue && (
            <button
              type="button"
              data-testid={`run-issue-${issue.ref}`}
              disabled={!executionEnabled}
              onClick={() => onRunIssue(issue.ref)}
            >
              Executar issue
            </button>
          )}
          {running && (
            <button type="button" data-testid={`follow-agent-${issue.ref}`} onClick={() => onFollow?.(issue.ref, run?.runId ?? overlay?.runId)}>Acompanhar agente</button>
          )}
        </div>
        {running && overlay?.operatorWaiting && !interaction && (
          <p className="board-waiting" data-testid={`agent-waiting-${issue.ref}`}>O agente aguarda uma resposta.</p>
        )}
        {pause && (
          <div className="board-pause" data-testid={`run-pause-${issue.ref}`}>
            <p className="board-pause-reason" data-testid={`run-pause-reason-${issue.ref}`}>
              Pausa: <code>{pause.reason}</code>
            </p>
            <div className="board-pause-choices" data-testid={`run-pause-choices-${issue.ref}`}>
              {pause.choices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  data-testid={`pause-choice-${issue.ref}-${choice}`}
                  onClick={() => onAnswerPause?.(issue.ref, choice)}
                >
                  {choice}
                </button>
              ))}
            </div>
          </div>
        )}
        {interaction && <div className="board-interaction" data-testid={`issue-interaction-${issue.ref}`}>{interaction}</div>}
      </article>,
    );
  }

  const nextRunnableRef =
    board.frontier[0] ??
    issues.find((item) => item.status !== 'done' && !item.frontierBlocked)?.ref;

  return (
    <section className="issue-board" data-testid="issue-board" aria-label="Issues e Specs">
      <div className="board-toolbar">
        <div>
          <h2>Quadro</h2>
          <p>Specs, Issues e as fases do Gantry. Arraste o quadro para o lado para ver as lanes.</p>
        </div>
        <button type="button" data-testid="board-refresh" onClick={onRefresh}>Atualizar quadro</button>
      </div>
      <div className="board-affordances" aria-label="Ações de execução">
        <button
          type="button"
          data-testid="run-affordance"
          disabled={!executionEnabled}
          onClick={() => {
            if (nextRunnableRef && onRunIssue) onRunIssue(nextRunnableRef);
          }}
        >
          Run
        </button>
        <button type="button" data-testid="plan-affordance" disabled={!executionEnabled}>Plan</button>
        <button type="button" data-testid="approve-affordance" disabled={!executionEnabled}>Approve</button>
      </div>
      {!executionEnabled && board.explanation && (
        <p className="board-explanation" data-testid="execution-unavailable">{board.explanation}</p>
      )}
      <div className="board-lanes" data-testid="board-lanes">
        {BOARD_LANES.map((lane) => (
          <section key={lane} className="board-lane" data-testid={`lane-${lane}`} aria-label={LANE_LABEL[lane]}>
            <h3>{LANE_LABEL[lane]} <span>{lanes[lane].length}</span></h3>
            <div className="board-lane-cards" data-testid={lane === 'issues' ? 'issue-cards' : lane === 'specs' ? 'spec-cards' : undefined}>
              {lanes[lane].length === 0 && <p className="board-lane-empty">Nenhum card</p>}
              {lanes[lane]}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
