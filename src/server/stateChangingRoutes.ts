/**
 * State-changing routes the HTTP server registers.
 *
 * Protection does not depend on this list: `createHarnessServer` refuses every
 * POST, PUT, PATCH and DELETE before routing. The list is the registry
 * `app.ts` dispatches through `matchesRoute`. `path` is an example the tests
 * attack; `match` is the predicate the handler uses.
 */
function partsOf(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

function exact(expected: string): (pathname: string) => boolean {
  return (pathname) => pathname === expected;
}

function projectSuffix(suffix: string, length: number): (pathname: string) => boolean {
  return (pathname) => pathname.startsWith('/api/projects/') && pathname.endsWith(suffix) && partsOf(pathname).length === length;
}

function paneAction(action: string | undefined): (pathname: string) => boolean {
  return (pathname) => {
    if (!pathname.startsWith('/api/projects/') || !pathname.includes('/panes/')) return false;
    return partsOf(pathname)[5] === action;
  };
}

function runAction(action: string): (pathname: string) => boolean {
  return (pathname) => {
    if (!pathname.startsWith('/api/projects/') || !pathname.includes('/runs/')) return false;
    return partsOf(pathname)[5] === action;
  };
}

export const STATE_CHANGING_ROUTES = [
  { id: 'pair-verify', method: 'POST', path: '/api/auth/pair/verify', match: exact('/api/auth/pair/verify') },
  { id: 'pair-generate', method: 'POST', path: '/api/auth/pair/generate', match: exact('/api/auth/pair/generate') },
  { id: 'workspace-state', method: 'PUT', path: '/api/workspace/state', match: exact('/api/workspace/state') },
  { id: 'project-create', method: 'POST', path: '/api/projects', match: exact('/api/projects') },
  { id: 'project-delete', method: 'DELETE', path: '/api/projects/project-id', match: (pathname: string) => pathname.startsWith('/api/projects/') && partsOf(pathname).length === 3 },
  { id: 'worktree-preview', method: 'POST', path: '/api/projects/project-id/worktree/preview', match: (pathname: string) => /^\/api\/projects\/[^/]+\/worktree\/preview$/.test(pathname) },
  { id: 'worktree-clean', method: 'POST', path: '/api/projects/project-id/worktree/clean', match: (pathname: string) => /^\/api\/projects\/[^/]+\/worktree\/clean$/.test(pathname) },
  { id: 'bootstrap', method: 'POST', path: '/api/projects/project-id/bootstrap', match: projectSuffix('/bootstrap', 4) },
  { id: 'setup-preview', method: 'POST', path: '/api/projects/project-id/setup/preview', match: projectSuffix('/setup/preview', 5) },
  { id: 'setup-apply', method: 'POST', path: '/api/projects/project-id/setup/apply', match: projectSuffix('/setup/apply', 5) },
  { id: 'pane-create', method: 'POST', path: '/api/projects/project-id/panes', match: projectSuffix('/panes', 4) },
  { id: 'pane-delete', method: 'DELETE', path: '/api/projects/project-id/panes/pane-id', match: paneAction(undefined) },
  { id: 'pane-resize', method: 'POST', path: '/api/projects/project-id/panes/pane-id/resize', match: paneAction('resize') },
  { id: 'pane-input', method: 'POST', path: '/api/projects/project-id/panes/pane-id/input', match: paneAction('input') },
  { id: 'pane-toggle', method: 'POST', path: '/api/projects/project-id/panes/pane-id/toggle', match: paneAction('toggle') },
  { id: 'artifact-write', method: 'PUT', path: '/api/projects/project-id/artifacts', match: projectSuffix('/artifacts', 4) },
  { id: 'wave-execute', method: 'POST', path: '/api/projects/project-id/waves/execute', match: projectSuffix('/waves/execute', 5) },
  { id: 'run-create', method: 'POST', path: '/api/projects/project-id/runs', match: projectSuffix('/runs', 4) },
  { id: 'run-answer', method: 'POST', path: '/api/projects/project-id/runs/run-id/answer', match: runAction('answer') },
  { id: 'run-resume', method: 'POST', path: '/api/projects/project-id/runs/run-id/resume', match: runAction('resume') },
  { id: 'run-discard', method: 'POST', path: '/api/projects/project-id/runs/run-id/discard', match: runAction('discard') },
  { id: 'run-approve', method: 'POST', path: '/api/projects/project-id/runs/run-id/approve', match: runAction('approve') },
  { id: 'run-pr-closed', method: 'POST', path: '/api/projects/project-id/runs/run-id/pr-closed', match: runAction('pr-closed') },
  { id: 'run-close-pr', method: 'POST', path: '/api/projects/project-id/runs/run-id/close-pr', match: runAction('close-pr') },
  { id: 'run-reopen', method: 'POST', path: '/api/projects/project-id/runs/run-id/reopen', match: runAction('reopen') },
  { id: 'run-pr-reopen', method: 'POST', path: '/api/projects/project-id/runs/run-id/pr-reopen', match: runAction('pr-reopen') },
  { id: 'settings-execution', method: 'PUT', path: '/api/settings/execution', match: exact('/api/settings/execution') },
  { id: 'settings-terminal', method: 'PUT', path: '/api/settings/terminal', match: exact('/api/settings/terminal') },
  { id: 'cli-dispatch', method: 'POST', path: '/api/cli/dispatch', match: exact('/api/cli/dispatch') },
] as const;

export type StateChangingRoute = (typeof STATE_CHANGING_ROUTES)[number];
export type StateChangingRouteId = StateChangingRoute['id'];

const routesById = new Map(STATE_CHANGING_ROUTES.map((route) => [route.id, route]));

export function matchesRoute(id: StateChangingRouteId, pathname: string, method: string | undefined): boolean {
  const route = routesById.get(id);
  return route !== undefined && route.method === method && route.match(pathname);
}
