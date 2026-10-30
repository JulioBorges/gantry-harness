/**
 * State-changing routes the HTTP server registers.
 *
 * Protection does not depend on this list: `createHarnessServer` refuses every
 * POST, PUT, PATCH and DELETE before routing. The list is the inventory those
 * routes must keep in sync with `src/server/app.ts`. `marker` is the source
 * text that selects the route, and `STATE_CHANGING_METHOD_CHECKS` is the number
 * of `req.method === 'POST'|'PUT'|'PATCH'|'DELETE'` comparisons in that file.
 * One comparison can cover more than one path (worktree preview/clean, and the
 * pull-request close/reopen aliases).
 */
export interface StateChangingRoute {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  marker: string;
}

export const STATE_CHANGING_METHOD_CHECKS = 26;

export const STATE_CHANGING_ROUTES: readonly StateChangingRoute[] = [
  { method: 'POST', path: '/api/auth/pair/verify', marker: "pathname === '/api/auth/pair/verify'" },
  { method: 'POST', path: '/api/auth/pair/generate', marker: "pathname === '/api/auth/pair/generate'" },
  { method: 'PUT', path: '/api/workspace/state', marker: "pathname === '/api/workspace/state' && req.method === 'PUT'" },
  { method: 'POST', path: '/api/projects', marker: "pathname === '/api/projects' && req.method === 'POST'" },
  { method: 'DELETE', path: '/api/projects/project-id', marker: "pathname.startsWith('/api/projects/') && req.method === 'DELETE'" },
  { method: 'POST', path: '/api/projects/project-id/worktree/preview', marker: 'worktree\\/(preview|clean)' },
  { method: 'POST', path: '/api/projects/project-id/worktree/clean', marker: 'worktree\\/(preview|clean)' },
  { method: 'POST', path: '/api/projects/project-id/bootstrap', marker: "endsWith('/bootstrap')" },
  { method: 'POST', path: '/api/projects/project-id/setup/preview', marker: "endsWith('/setup/preview')" },
  { method: 'POST', path: '/api/projects/project-id/setup/apply', marker: "endsWith('/setup/apply')" },
  { method: 'POST', path: '/api/projects/project-id/panes', marker: "endsWith('/panes')" },
  { method: 'DELETE', path: '/api/projects/project-id/panes/pane-id', marker: "!subAction && req.method === 'DELETE'" },
  { method: 'POST', path: '/api/projects/project-id/panes/pane-id/resize', marker: "subAction === 'resize'" },
  { method: 'POST', path: '/api/projects/project-id/panes/pane-id/input', marker: "subAction === 'input'" },
  { method: 'POST', path: '/api/projects/project-id/panes/pane-id/toggle', marker: "subAction === 'toggle'" },
  { method: 'PUT', path: '/api/projects/project-id/artifacts', marker: "endsWith('/artifacts')" },
  { method: 'POST', path: '/api/projects/project-id/waves/execute', marker: "endsWith('/waves/execute')" },
  { method: 'POST', path: '/api/projects/project-id/runs', marker: "endsWith('/runs')" },
  { method: 'POST', path: '/api/projects/project-id/runs/run-id/answer', marker: "action === 'answer'" },
  { method: 'POST', path: '/api/projects/project-id/runs/run-id/resume', marker: "action === 'resume'" },
  { method: 'POST', path: '/api/projects/project-id/runs/run-id/discard', marker: "action === 'discard'" },
  { method: 'POST', path: '/api/projects/project-id/runs/run-id/approve', marker: "action === 'approve'" },
  { method: 'POST', path: '/api/projects/project-id/runs/run-id/pr-closed', marker: "action === 'pr-closed'" },
  { method: 'POST', path: '/api/projects/project-id/runs/run-id/close-pr', marker: "action === 'close-pr'" },
  { method: 'POST', path: '/api/projects/project-id/runs/run-id/reopen', marker: "action === 'reopen'" },
  { method: 'POST', path: '/api/projects/project-id/runs/run-id/pr-reopen', marker: "action === 'pr-reopen'" },
  { method: 'PUT', path: '/api/settings/execution', marker: "pathname === '/api/settings/execution'" },
  { method: 'PUT', path: '/api/settings/terminal', marker: "pathname === '/api/settings/terminal'" },
  { method: 'POST', path: '/api/cli/dispatch', marker: "pathname === '/api/cli/dispatch'" },
];
