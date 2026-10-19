import React from 'react';
import {
  BOARD_LANES,
  LANE_LABEL,
  PHASE_LABEL,
  issueLane,
  issuePhase,
  orderedIssues,
  type BoardLane,
  type BoardSnapshot,
  type IssueRunOverlay,
} from '../boardModel.js';

export function BoardView({
  board,
  hasProject,
  overlays = [],
  specInteractions = {},
  issueInteractions = {},
  onRefresh,
  onOpenPath,
  onFollow,
}: {
  board: BoardSnapshot | null;
  hasProject: boolean;
  overlays?: IssueRunOverlay[];
  specInteractions?: Record<string, React.ReactNode>;
  issueInteractions?: Record<string, React.ReactNode>;
  onRefresh: () => void;
  onOpenPath?: (path: string) => void;
  onFollow?: (ref: string, runId?: string) => void;
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
    const phase = issuePhase(issue);
    const lane = issueLane(issue, overlays);
    const overlay = [...overlays].reverse().find((item) => item.ref === issue.ref);
    const spec = board.specs.find((item) => item.slug === issue.spec);
    const interaction = issueInteractions[issue.ref];
    const running = lane === 'plan' || lane === 'implement' || lane === 'review' || lane === 'critic';
    lanes[lane].push(
      <article key={issue.ref} className="board-card" data-testid={`issue-card-${issue.ref}`} data-phase={phase} data-ref={issue.ref} data-lane={lane}>
        <p className="board-ref"><code>{issue.ref}</code></p>
        <h3>{issue.title}</h3>
        <p className="board-phase">{PHASE_LABEL[phase]}</p>
        {phase === 'blocked' && (
          <ul className="board-blockers" aria-label={`Open blockers for ${issue.ref}`}>
            {issue.openBlockers.map((blocker) => <li key={blocker} data-testid="open-blocker">{blocker}</li>)}
          </ul>
        )}
        <div className="board-card-actions">
          {spec && <button type="button" data-testid={`open-spec-${issue.ref}`} onClick={() => onOpenPath?.(spec.path)}>Abrir spec</button>}
          {running && (
            <button type="button" data-testid={`follow-agent-${issue.ref}`} onClick={() => onFollow?.(issue.ref, overlay?.runId)}>Acompanhar agente</button>
          )}
        </div>
        {running && overlay?.operatorWaiting && !interaction && (
          <p className="board-waiting" data-testid={`agent-waiting-${issue.ref}`}>O agente aguarda uma resposta.</p>
        )}
        {interaction && <div className="board-interaction" data-testid={`issue-interaction-${issue.ref}`}>{interaction}</div>}
      </article>,
    );
  }

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
        <button type="button" data-testid="run-affordance" disabled={!executionEnabled}>Run</button>
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
