import type { BoardIssue } from '../types.js';

export type CardPhase =
  | 'ready'
  | 'blocked'
  | 'plan'
  | 'implement'
  | 'checks'
  | 'review'
  | 'critic'
  | 'awaiting'
  | 'done';

const RUN_PHASE: Record<string, CardPhase> = {
  plan: 'plan',
  'plan-approval': 'plan',
  implement: 'implement',
  checks: 'checks',
  review: 'review',
  critic: 'critic',
  ready: 'awaiting',
};

export function cardPhase(issue: BoardIssue): CardPhase {
  if (issue.status === 'done') return 'done';
  const running = issue.runPhase ? RUN_PHASE[issue.runPhase] : undefined;
  if (running) return running;
  if (issue.frontierBlocked) return 'blocked';
  return 'ready';
}

export const PHASE_LABEL: Record<CardPhase, string> = {
  ready: 'Ready to agent',
  blocked: 'Blocked',
  plan: 'Plan',
  implement: 'Implement',
  checks: 'Checks',
  review: 'Review',
  critic: 'Critic',
  awaiting: 'Ready for approval',
  done: 'Done',
};

export function cardLabel(issue: BoardIssue, phase: CardPhase): string {
  if (issue.runPhase === 'plan-approval') return 'Plan approval';
  return PHASE_LABEL[phase];
}
