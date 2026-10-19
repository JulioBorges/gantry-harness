// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BoardView } from '../src/client/BoardView.js';
import type { BoardResponse } from '../src/types.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const readyBoard: BoardResponse = {
  pack: { kind: 'pinned', cliPath: '/repo/.agents/skills/gantry/scripts/cli.py' },
  execution: { enabled: true, reason: null },
  specs: [{ slug: 'sample', path: '.scratch/sample/spec.md', executable: false }],
  frontier: ['sample#01'],
  issues: [
    {
      ref: 'sample#01', spec: 'sample', number: 1, title: 'Ready work', status: 'ready-for-agent',
      path: '.scratch/sample/issues/01-ready.md', frontierBlocked: false, openBlockers: [], runPhase: null,
    },
    {
      ref: 'sample#02', spec: 'sample', number: 2, title: 'Blocked work', status: 'ready-for-agent',
      path: '.scratch/sample/issues/02-blocked.md', frontierBlocked: true, openBlockers: ['sample#01'], runPhase: null,
    },
    {
      ref: 'sample#03', spec: 'sample', number: 3, title: 'Finished work', status: 'done',
      path: '.scratch/sample/issues/03-done.md', frontierBlocked: false, openBlockers: [], runPhase: 'review',
    },
  ],
};

function stubBoard(payload: BoardResponse): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => Response.json(payload));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

it('renders ready, blocked and done cards from board data', async () => {
  stubBoard(readyBoard);
  render(<BoardView projectId="project" />);

  const ready = await screen.findByText('Ready work');
  expect(ready.closest('article')?.dataset.phase).toBe('ready');
  expect(ready.closest('article')?.textContent).toContain('Ready to agent');

  const blocked = screen.getByText('Blocked work').closest('article');
  expect(blocked?.dataset.phase).toBe('blocked');
  expect(blocked?.textContent).toContain('Blocked by sample#01');

  const done = screen.getByText('Finished work').closest('article');
  expect(done?.dataset.phase).toBe('done');
  expect(done?.textContent).toContain('Done');

  const spec = screen.getByText('Non-executable support document').closest('article');
  expect(spec?.dataset.executable).toBe('false');
  expect(spec?.textContent).toContain('Non-executable support document');
  expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
});

it('places a running Issue in the agent phase recorded by the pack', async () => {
  stubBoard({
    ...readyBoard,
    issues: [
      { ...readyBoard.issues[0], title: 'Implementing', runPhase: 'implement' },
      { ...readyBoard.issues[1], title: 'In review', frontierBlocked: false, openBlockers: [], runPhase: 'review' },
      { ...readyBoard.issues[2], title: 'With the critic', status: 'ready-for-agent', runPhase: 'critic' },
    ],
  });
  render(<BoardView projectId="project" />);

  expect((await screen.findByText('Implementing')).closest('article')?.dataset.phase).toBe('implement');
  const review = screen.getByText('In review').closest('article');
  expect(review?.dataset.phase).toBe('review');
  expect(review?.textContent).toContain('Review');
  const critic = screen.getByText('With the critic').closest('article');
  expect(critic?.dataset.phase).toBe('critic');
  expect(critic?.textContent).toContain('Critic');
});

it('shows disabled run, plan and approve actions when the pack cannot be resolved', async () => {
  stubBoard({
    pack: { kind: 'none' },
    execution: {
      enabled: false,
      reason: 'No Gantry pack is installed in this repository and gantry is not on PATH.',
    },
    issues: [],
    specs: [],
    frontier: [],
  });
  render(<BoardView projectId="project" />);

  expect((await screen.findByRole('status')).textContent).toContain('gantry is not on PATH');
  expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Plan' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
});

it('refreshes by asking the server to read the repository again', async () => {
  const first = readyBoard;
  const second: BoardResponse = {
    ...readyBoard,
    issues: [{ ...readyBoard.issues[0], title: 'Ready work updated', status: 'done' }],
    frontier: [],
  };
  let calls = 0;
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    calls += 1;
    return Response.json(calls === 1 ? first : second);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<BoardView projectId="project" />);

  await screen.findByText('Ready work');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('Ready work updated')).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(String(fetchMock.mock.calls[1][0])).toBe('/api/projects/project/board');
  expect(fetchMock.mock.calls[1][1]).toMatchObject({ cache: 'no-store' });
});
