import type { BoardIssue } from '../types.js';

export type CardPhase = 'ready' | 'blocked' | 'done';

export function cardPhase(issue: BoardIssue): CardPhase {
  if (issue.status === 'done') return 'done';
  if (issue.frontierBlocked) return 'blocked';
  return 'ready';
}

export const PHASE_LABEL: Record<CardPhase, string> = {
  ready: 'Ready to agent',
  blocked: 'Blocked',
  done: 'Done',
};
