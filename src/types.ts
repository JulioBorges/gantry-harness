export type LiveBadgeState = 'working' | 'needs input' | 'done' | 'blocked' | 'idle';

// Deprecated types - kept for compatibility during migration
export type SanitizedProviderSettings = Record<string, unknown>;
export type CoordinatorConnection = Record<string, unknown>;
export type PreparedGantryCommand = { command: string; args: string[] };
export type DecisionCardPayload = { kind: string; resolved?: boolean };
export type ProviderSettingsInput = Record<string, unknown>;

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

export interface ChatMessageRecord {
  id: string;
  projectId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'subagent';
  content: string;
  decisionCard?: DecisionCardPayload;  // Deprecated - kept for compatibility
  turnBlocks?: Array<{
    type: 'tool' | 'command' | 'diff' | 'text';
    title: string;
    content: string;
    filePath?: string;
    collapsed?: boolean;
  }>;
  createdAt: string;
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

export type PackResolution =
  | { kind: 'pinned'; cliPath: string }
  | { kind: 'path'; executable: string }
  | { kind: 'none' };

export interface BoardIssue {
  ref: string;
  spec: string;
  number: number;
  title: string;
  status: string;
  path: string;
  frontierBlocked: boolean;
  openBlockers: string[];
  /** Pack run-record phase (`implement`, `review`, `critic`, …), or null when no Run is recorded. */
  runPhase: string | null;
}

export interface BoardSpec {
  slug: string;
  path: string;
  executable: boolean;
}

export interface BoardPayload {
  issues: BoardIssue[];
  specs: BoardSpec[];
  frontier: string[];
}

export interface BoardResponse extends BoardPayload {
  pack: PackResolution;
  execution: { enabled: boolean; reason: string | null };
}
