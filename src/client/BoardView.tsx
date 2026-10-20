import React, { useState } from 'react';
import {
  BOARD_LANES,
  LANE_LABEL,
  NO_PACK_EXPLANATION,
  PHASE_LABEL,
  issueLane,
  issuePhase,
  mergeBoardWithPlanRuns,
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
  onConfigureProject,
  onExecuteWave,
  onStartPlan,
  onAnswerPause,
  onResumeRun,
  onDiscardRun,
  onApproveRun,
  onReopenPr,
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
  onConfigureProject?: () => void;
  onExecuteWave?: () => void;
  onStartPlan?: (slug: string) => void;
  onAnswerPause?: (ref: string, choice: string) => void;
  onResumeRun?: (ref: string) => void;
  onDiscardRun?: (ref: string) => void;
  onApproveRun?: (ref: string) => void;
  onReopenPr?: (ref: string) => void;
}): React.ReactElement {
  const [planSlug, setPlanSlug] = useState('');
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

  const effectiveBoard = mergeBoardWithPlanRuns(board, runs);
  const executionEnabled = effectiveBoard.executionEnabled;
  const issues = orderedIssues(effectiveBoard);
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

  for (const spec of effectiveBoard.specs) {
    const interaction = specInteractions[spec.slug];
    const planRunError = [...runs].reverse().find((item) => item.slug === spec.slug && item.error)?.error ?? null;
    lanes.specs.push(
      <article key={spec.slug} className="board-card spec-card" data-testid={`spec-card-${spec.slug}`} data-executable="false" data-lane="specs">
        <p className="board-ref"><code>{spec.slug}</code></p>
        <h3>{spec.path}</h3>
        <p className="board-phase">non-executable</p>
        {planRunError && (
          <div className="board-run-error" role="alert" data-testid={`run-error-${spec.slug}`}>
            <strong>{planRunError.reason ? `${planRunError.code} (${planRunError.reason})` : planRunError.code}</strong>
            {planRunError.message && <p>{planRunError.message}</p>}
          </div>
        )}
        <div className="board-card-actions">
          <button type="button" data-testid={`open-spec-${spec.slug}`} onClick={() => onOpenPath?.(spec.path)}>Abrir documentação</button>
        </div>
        {interaction && <div className="board-interaction" data-testid={`spec-interaction-${spec.slug}`}>{interaction}</div>}
      </article>,
    );
  }

  for (const issue of issues) {
    const overlay = [...effectiveOverlays].reverse().find((item) => item.ref === issue.ref);
    const run = [...runs].reverse().find(
      (item) => item.ref === issue.ref || (item.kind === 'plan' && item.slug === issue.spec && issue.number === 1),
    );
    const phase = issuePhase(issue, overlay, run);
    const lane = issueLane(issue, effectiveOverlays);
    const spec = effectiveBoard.specs.find((item) => item.slug === issue.spec);
    const interaction = issueInteractions[issue.ref];
    const running = lane === 'plan' || lane === 'implement' || lane === 'review' || lane === 'critic';
    const pause = run?.pause ?? overlay?.pause ?? null;
    const error = run?.error ?? overlay?.error ?? null;
    const worktree = run?.worktree ?? overlay?.worktree ?? null;
    const branch = run?.branch ?? overlay?.branch ?? null;
    const prUrl = run?.prUrl ?? overlay?.prUrl ?? null;
    const canResumeOrDiscard = (run?.status === 'stopped' || run?.status === 'failed') && Boolean(run?.worktree);
    const canApprove =
      (run?.status === 'ready-for-approval' && run?.prState !== 'closed') || run?.prState === 'reopened';
    const canReopenPr = run?.prState === 'closed';
    const canStartRun =
      issue.status !== 'done' &&
      run?.status !== 'running' &&
      run?.status !== 'paused' &&
      !canResumeOrDiscard &&
      !canApprove &&
      !canReopenPr;
    const pauseSpecPath = pause?.specPath ?? (pause?.reason === 'plan-approval' ? run?.specPath : undefined);
    const pauseIssuePath = pause?.issuePath ?? (pause?.reason === 'plan-approval' ? run?.issuePath : undefined);

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
        {prUrl && (
          <p className="board-pr-url" data-testid={`run-pr-url-${issue.ref}`}>
            <a href={prUrl} target="_blank" rel="noreferrer">{prUrl}</a>
          </p>
        )}
        {error && (
          <div className="board-run-error" role="alert" data-testid={`run-error-${issue.ref}`}>
            {error.code === 'role-command-missing' || error.reason === 'role-command-missing' ? <><strong>Configure um comando executável para cada papel exigido antes de executar esta Issue.</strong><button onClick={onConfigureProject}>Configurar este projeto</button></> : <strong>{error.reason ? `${error.code} (${error.reason})` : error.code}</strong>}
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
              disabled={!executionEnabled || issue.frontierBlocked}
              onClick={() => onRunIssue(issue.ref)}
            >
              Executar issue
            </button>
          )}
          {canResumeOrDiscard && onResumeRun && (
            <button
              type="button"
              data-testid={`resume-run-${issue.ref}`}
              disabled={!executionEnabled}
              onClick={() => onResumeRun(issue.ref)}
            >
              Retomar
            </button>
          )}
          {canResumeOrDiscard && onDiscardRun && (
            <button
              type="button"
              data-testid={`discard-run-${issue.ref}`}
              onClick={() => onDiscardRun(issue.ref)}
            >
              Descartar
            </button>
          )}
          {canApprove && onApproveRun && (
            <button
              type="button"
              data-testid={`approve-run-${issue.ref}`}
              disabled={!executionEnabled}
              onClick={() => onApproveRun(issue.ref)}
            >
              Aprovar
            </button>
          )}
          {canReopenPr && onReopenPr && (
            <button
              type="button"
              data-testid={`reopen-pr-${issue.ref}`}
              onClick={() => onReopenPr(issue.ref)}
            >
              Reabrir PR
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
            {(pauseSpecPath || pauseIssuePath) && (
              <div className="board-pause-files" data-testid={`run-pause-files-${issue.ref}`}>
                {pauseSpecPath && (
                  <button
                    type="button"
                    className="btn-file-link"
                    data-testid={`pause-spec-path-${issue.ref}`}
                    onClick={() => onOpenPath?.(pauseSpecPath)}
                  >
                    {pauseSpecPath}
                  </button>
                )}
                {pauseIssuePath && (
                  <button
                    type="button"
                    className="btn-file-link"
                    data-testid={`pause-issue-path-${issue.ref}`}
                    onClick={() => onOpenPath?.(pauseIssuePath)}
                  >
                    {pauseIssuePath}
                  </button>
                )}
              </div>
            )}
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
    effectiveBoard.frontier[0] ??
    issues.find((item) => item.status !== 'done' && !item.frontierBlocked)?.ref;
  const nextApprovableRef = runs.find(
    (item) => (item.status === 'ready-for-approval' && item.prState !== 'closed') || item.prState === 'reopened',
  )?.ref;

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
            if (onExecuteWave) {
              onExecuteWave();
            } else if (nextRunnableRef && onRunIssue) {
              onRunIssue(nextRunnableRef);
            }
          }}
        >
          Run
        </button>
        <input
          type="text"
          data-testid="plan-slug-input"
          aria-label="Slug do plano"
          placeholder="novo-slug"
          value={planSlug}
          disabled={!executionEnabled}
          onChange={(event) => setPlanSlug(event.target.value)}
        />
        <button
          type="button"
          data-testid="plan-affordance"
          disabled={!executionEnabled}
          onClick={() => {
            const slug = planSlug.trim();
            if (slug && onStartPlan) {
              onStartPlan(slug);
              setPlanSlug('');
            }
          }}
        >
          Plan
        </button>
        <button
          type="button"
          data-testid="approve-affordance"
          disabled={!executionEnabled}
          onClick={() => {
            if (nextApprovableRef && onApproveRun) onApproveRun(nextApprovableRef);
          }}
        >
          Approve
        </button>
      </div>
      {!executionEnabled && effectiveBoard.explanation && effectiveBoard.explanation !== NO_PACK_EXPLANATION && (
        <p className="board-explanation" data-testid="execution-unavailable">{effectiveBoard.explanation}</p>
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
