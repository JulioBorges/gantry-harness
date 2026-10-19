export type LiveBadgeState = 'working' | 'needs input' | 'done' | 'blocked' | 'idle';

export interface WorkspaceTab {
  id: string;
  title: string;
  kind: 'factory' | 'agent' | 'kanban' | 'setup';
  mode: 'chat' | 'terminal';
  harness?: string;
  worktreePath?: string;
  paneId?: string;
}

export interface SplitPaneConfig {
  paneId: string;
  tabId: string;
  direction: 'horizontal' | 'vertical';
  ratio: number;
}

export interface WorkspaceLayoutState {
  activeProjectId: string | null;
  activeSessionId: string | null;
  openTabs: WorkspaceTab[];
  splitPanes: SplitPaneConfig[];
  scrollPositions: Record<string, number>;
}

export interface RegisteredProject {
  id: string;
  name: string;
  path: string;
  unitId: string;
  badgeState: LiveBadgeState;
  createdAt: string;
  updatedAt: string;
}

export interface RoleSelection {
  harness: string;
  model: string;
  effort?: string;
}

export interface ExecutionSettings {
  hostHarness?: string;
  roles?: Record<string, RoleSelection>;
}

export type TerminalShell = 'system' | 'bash' | 'sh' | 'zsh' | 'cmd' | 'powershell' | 'pwsh';

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  shell: TerminalShell;
}

export interface TerminalEnvironment {
  platform: string;
  platformLabel: string;
  shells: Array<{ id: TerminalShell; label: string; available: boolean }>;
}
