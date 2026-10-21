// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { BoardView } from '../src/client/BoardView.js';
import type { BoardSnapshot, HarnessRunRecord } from '../src/boardModel.js';

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
    render(<BoardView board={{ ...board, issues: [], frontier: [] }} hasProject onRefresh={() => undefined}
      runs={[{ ...run, ref: 'feature', kind: 'plan', status: 'failed', worktree: null, error: { code: 'setup-invalid', reason: 'role-command-missing' } }]} />);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(within(screen.getByTestId('spec-card-feature')).queryByRole('alert')).toBeNull();
    expect(within(screen.getByTestId('issue-card-feature#01')).getByRole('alert').textContent).toContain('Falta configurar');
  });
});
