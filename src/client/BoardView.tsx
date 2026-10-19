import React from 'react';
import {
  PHASE_LABEL,
  issuePhase,
  orderedIssues,
  type BoardSnapshot,
} from '../boardModel.js';

export function BoardView({
  board,
  hasProject,
  onRefresh,
}: {
  board: BoardSnapshot | null;
  hasProject: boolean;
  onRefresh: () => void;
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

  return (
    <section className="issue-board" data-testid="issue-board" aria-label="Issues e Specs">
      <div className="board-toolbar">
        <div>
          <h2>Issues e Specs</h2>
          <p>Lido do repositório pelo comando board do pack.</p>
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
      <div className="board-columns">
        <div>
          <h3>Issues</h3>
          <div className="board-grid" data-testid="issue-cards">
            {issues.map((issue) => {
              const phase = issuePhase(issue);
              return (
                <article key={issue.ref} className="board-card" data-testid={`issue-card-${issue.ref}`} data-phase={phase} data-ref={issue.ref}>
                  <p className="board-ref"><code>{issue.ref}</code></p>
                  <h3>{issue.title}</h3>
                  <p className="board-phase">{PHASE_LABEL[phase]}</p>
                  {phase === 'blocked' && (
                    <ul className="board-blockers" aria-label={`Open blockers for ${issue.ref}`}>
                      {issue.openBlockers.map((blocker) => <li key={blocker} data-testid="open-blocker">{blocker}</li>)}
                    </ul>
                  )}
                </article>
              );
            })}
          </div>
        </div>
        <div>
          <h3>Specs</h3>
          <div className="board-grid" data-testid="spec-cards">
            {board.specs.map((spec) => (
              <article key={spec.slug} className="board-card spec-card" data-testid={`spec-card-${spec.slug}`} data-executable="false">
                <p className="board-ref"><code>{spec.slug}</code></p>
                <h3>{spec.path}</h3>
                <p className="board-phase">non-executable</p>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
