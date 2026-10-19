import React, { useCallback, useEffect, useState } from 'react';
import type { BoardIssue, BoardResponse, BoardSpec } from '../types.js';
import { PHASE_LABEL, cardLabel, cardPhase, type CardPhase } from './cardPhase.js';

interface BoardViewProps {
  projectId: string;
  apiBaseUrl?: string;
}

const COLUMNS: CardPhase[] = [
  'ready',
  'blocked',
  'plan',
  'implement',
  'checks',
  'review',
  'critic',
  'awaiting',
  'done',
];

export function BoardView({ projectId, apiBaseUrl = '' }: BoardViewProps): React.ReactElement {
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBoard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/api/projects/${projectId}/board`, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Failed to load board: ${response.statusText}`);
      }
      setBoard(await response.json() as BoardResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, projectId]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  if (loading && !board) {
    return <div className="board-status">Loading board...</div>;
  }

  if (error) {
    return <div className="board-error">Error: {error}</div>;
  }

  if (!board) {
    return <div className="board" />;
  }

  const grouped: Record<CardPhase, BoardIssue[]> = {
    ready: [],
    blocked: [],
    plan: [],
    implement: [],
    checks: [],
    review: [],
    critic: [],
    awaiting: [],
    done: [],
  };
  for (const issue of board.issues) {
    grouped[cardPhase(issue)].push(issue);
  }

  return (
    <div className="board">
      <div className="board-header">
        <div>
          <h2>Issues and specs</h2>
          <p>Pack: {board.pack.kind}</p>
        </div>
        <div className="board-actions">
          {!board.execution.enabled && (
            <>
              <button type="button" disabled>Run</button>
              <button type="button" disabled>Plan</button>
              <button type="button" disabled>Approve</button>
            </>
          )}
          <button type="button" onClick={() => void loadBoard()} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {!board.execution.enabled && board.execution.reason && (
        <p className="board-note" role="status">{board.execution.reason}</p>
      )}

      <div className="board-columns">
        {COLUMNS.map((phase) => (
          <section className="board-column" key={phase} aria-label={PHASE_LABEL[phase]}>
            <header>
              <h3>{PHASE_LABEL[phase]}</h3>
              <span>{grouped[phase].length}</span>
            </header>
            <div className="board-column-body">
              {grouped[phase].length === 0 ? (
                <div className="board-empty">No issues</div>
              ) : (
                grouped[phase].map((issue) => <IssueCard key={issue.ref} issue={issue} phase={phase} />)
              )}
            </div>
          </section>
        ))}
        <section className="board-column" aria-label="Specs">
          <header>
            <h3>Specs</h3>
            <span>{board.specs.length}</span>
          </header>
          <div className="board-column-body">
            {board.specs.length === 0 ? (
              <div className="board-empty">No specs</div>
            ) : (
              board.specs.map((spec) => <SpecCard key={spec.slug} spec={spec} />)
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function IssueCard({ issue, phase }: { issue: BoardIssue; phase: CardPhase }): React.ReactElement {
  return (
    <article className="issue-card" data-phase={phase} data-ref={issue.ref}>
      <header>
        <span>{issue.ref}</span>
        <strong className={`phase-${phase}`}>{cardLabel(issue, phase)}</strong>
      </header>
      <h4>{issue.title}</h4>
      <p>{issue.spec}</p>
      {phase === 'blocked' && issue.openBlockers.length > 0 && (
        <ul className="blocker-list">
          {issue.openBlockers.map((blocker) => (
            <li key={blocker}>Blocked by {blocker}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function SpecCard({ spec }: { spec: BoardSpec }): React.ReactElement {
  return (
    <article className="spec-card" data-executable={spec.executable ? 'true' : 'false'}>
      <header>
        <h4>{spec.slug}</h4>
      </header>
      <code>{spec.path}</code>
      {!spec.executable && <p className="support-label">Non-executable support document</p>}
    </article>
  );
}
