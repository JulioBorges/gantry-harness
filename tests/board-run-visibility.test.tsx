// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BoardView } from '../src/client/BoardView.js';
import { issueWorktreeRuns, issueLane, overlaysFromRuns, mergeBoardWithPlanRuns, type BoardSnapshot, type HarnessRunRecord, type HarnessRunStatus } from '../src/boardModel.js';

const board: BoardSnapshot = {
  resolution: 'pinned', executionEnabled: true, explanation: null,
  issues: [{ ref: 'feature#01', spec: 'feature', number: 1, title: 'Entrega', status: 'ready-for-agent', path: '.scratch/feature/issues/01.md', frontierBlocked: false, openBlockers: [] }],
  specs: [{ slug: 'feature', path: '.scratch/feature/spec.md', executable: false }], frontier: ['feature#01'],
};
const run: HarnessRunRecord = {
  runId: 'run-1', projectId: 'project-1', ref: 'feature#01', slug: 'feature', kind: 'issue', status: 'running',
  childPid: null, pid: null, childHandle: null, lane: 'implement', packPhase: 'implement', branch: 'gantry/feature-01',
  worktree: '/tmp/feature-01', pushed: false, pause: null, pausedReason: null, pausedChoices: null,
  terminalEvent: null, error: null, prUrl: null, derivedPhase: 'implement', createdAt: '', updatedAt: '',
};
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Run visibility on the board', () => {
  it('brings a moved card into view without stealing scroll on unchanged renders', () => {
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      const props = { board, hasProject: true, onRefresh: () => undefined, onApproveRun: vi.fn() };
      const { rerender } = render(<BoardView {...props} runs={[run]} />);
      expect(within(screen.getByTestId('lane-implement')).getByTestId('issue-card-feature#01')).toBeTruthy();
      expect(scroll).not.toHaveBeenCalled();
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return { left: this.dataset.ref ? -300 : 0, right: this.dataset.ref ? -200 : 100, top: 0, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      });
      const ready = { ...run, status: 'ready-for-approval' as const, derivedPhase: 'ready-for-approval' as const, lane: 'critic' as const };
      rerender(<BoardView {...props} runs={[ready]} />);
      const card = within(screen.getByTestId('lane-issues')).getByTestId('issue-card-feature#01');
      expect(within(card).getByRole('button', { name: 'Aprovar' })).toBeTruthy();
      expect(scroll).toHaveBeenCalledTimes(1);
      rerender(<BoardView {...props} runs={[ready]} />);
      expect(scroll).toHaveBeenCalledTimes(1);
      rerender(<BoardView {...props} runs={[{ ...ready, status: 'approved-pending-merge', prUrl: 'https://example.test/pr/1' }]} />);
      expect(within(screen.getByTestId('lane-issues')).getByRole('link').getAttribute('href')).toBe('https://example.test/pr/1');
      const doneBoard = { ...board, issues: board.issues.map(issue => ({ ...issue, status: 'done' })) };
      rerender(<BoardView {...props} board={doneBoard} runs={[ready]} />);
      expect(within(screen.getByTestId('lane-done')).getByTestId('issue-card-feature#01')).toBeTruthy();
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it('puts a failed Plan diagnostic on a synthetic Issue card once', () => {
    const onRunIssue = vi.fn();
    render(<BoardView board={{ ...board, issues: [], frontier: [] }} hasProject onRefresh={() => undefined} onRunIssue={onRunIssue}
      runs={[{ ...run, ref: 'feature', kind: 'plan', status: 'failed', worktree: null, error: { code: 'setup-invalid', reason: 'role-command-missing' } }]} />);
    expect(screen.getByText(/Run de planejamento/)).toBeTruthy();
    expect(screen.getByTestId('issue-card-feature#01').getAttribute('data-phase')).toBe('failed');
    expect(screen.queryByTestId('run-issue-feature#01')).toBeNull();
    fireEvent.click(screen.getByTestId('run-affordance'));
    expect(onRunIssue).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(within(screen.getByTestId('spec-card-feature')).queryByRole('alert')).toBeNull();
    expect(within(screen.getByTestId('issue-card-feature#01')).getByRole('alert').textContent).toContain('Falta configurar');
  });
});


describe('Run projections shared by the board and sidebar', () => {
  it.each<[HarnessRunStatus, string]>([
    ['running', 'implement'], ['paused', 'implement'], ['stopped', 'issues'], ['failed', 'issues'],
    ['ready-for-approval', 'issues'], ['approved-pending-merge', 'issues'], ['discarded', 'issues'], ['rejected', 'issues'],
  ])('places %s Runs in %s while target completion always wins', (status, lane) => {
    const overlays = overlaysFromRuns([{ ...run, status }]);
    expect(issueLane(board.issues[0], overlays)).toBe(lane);
    expect(issueLane({ ...board.issues[0], status: 'done' }, overlays)).toBe('done');
  });

  it('selects only retained Issue worktrees from the selected project', () => {
    const retained = ['running', 'paused', 'stopped', 'failed', 'ready-for-approval', 'approved-pending-merge'] as const;
    const valid = retained.map((status, i) => ({ ...run, runId: `run-${i}`, status }));
    const excluded: HarnessRunRecord[] = [
      { ...run, projectId: 'other-project' },
      { ...run, kind: 'plan', ref: 'feature#01' },
      { ...run, worktree: null },
      { ...run, worktree: '/tmp/checkout' },
      { ...run, status: 'discarded' },
      { ...run, status: 'rejected' },
      { ...run, prState: 'closed' },
    ];
    expect(issueWorktreeRuns([...valid, ...excluded], 'project-1', '/tmp/checkout')).toEqual(valid);
    expect(issueWorktreeRuns(valid, null, '/tmp/checkout')).toEqual([]);
  });

  it('keeps a reopened PR approvable in Issues and retains its worktree in the sidebar', () => {
    const reopened: HarnessRunRecord = { ...run, prState: 'reopened', status: 'ready-for-approval', derivedPhase: 'ready-for-approval' };
    expect(issueWorktreeRuns([reopened], run.projectId, '/tmp/checkout')).toEqual([reopened]);
    const overlays = overlaysFromRuns([reopened]);
    expect(issueLane(board.issues[0], overlays)).toBe('issues');
    render(<BoardView board={board} hasProject runs={[reopened]} onRefresh={() => undefined} onApproveRun={() => undefined} />);
    expect(screen.getByTestId('approve-run-feature#01')).toBeTruthy();
  });

  it('marks Plan-only cards and leaves missing Issue paths absent until the pack supplies them', () => {
    const empty = { ...board, issues: [], frontier: [] };
    const plan: HarnessRunRecord = { ...run, kind: 'plan', ref: 'feature', worktree: null, error: { code: 'setup-invalid' } };
    const synthetic = mergeBoardWithPlanRuns(empty, [plan]).issues[0];
    expect(synthetic.synthetic).toBe(true);
    expect(synthetic.path).toBeUndefined();
    expect(mergeBoardWithPlanRuns(board, [plan]).issues[0]).toBe(board.issues[0]);
  });
});
