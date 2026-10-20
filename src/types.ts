export type RunLifecycleState =
  | 'idle'
  | 'bootstrapping_skills'
  | 'setup_review'
  | 'grilling_interview'
  | 'spec_validation'
  | 'requirement_review'
  | 'slicing_and_critique'
  | 'awaiting_plan_approval'
  | 'round_preflight'
  | 'round_executing'
  | 'awaiting_recovery_decision'
  | 'awaiting_handoff_decisions'
  | 'completed';

export type DecisionCardPayload =
  | {
      kind: 'grilling_round';
      slug: string;
      roundNumber: number;
      questions: Array<{
        id: string;
        title: string;
        body: string;
        options?: Array<{ label: string; description: string }>;
        recommendedAnswer: string;
      }>;
    }
  | {
      kind: 'spec_blocked';
      slug: string;
      source: 'spec_structural_validation' | 'requirement_critic';
      findings: Array<{ quote: string; reason: string }>;
    }
  | {
      kind: 'plan_approval';
      slug: string;
      specPath: string;
      issues: Array<{
        ref: string;
        title: string;
        path: string;
        blockedBy: string[];
        estimatedTokens: number;
        budgetTokens: number;
        overBudget: boolean;
      }>;
      waves: string[][];
      criticVerdict: { acceptable: boolean; problems: Array<{ problem: string; fix: string }> };
    }
  | {
      kind: 'issue_recovery';
      runId: string;
      issueRef: string;
      worktree: string;
      failureReason:
        | 'execution_unavailable'
        | 'verification_unavailable'
        | 'correction_budget_exhausted'
        | 'preflight_failed';
      correctionsSpent: number;
      currentSelection: { harness: string; model: string; effort?: string };
      availableReplacements: Array<{ harness: string; model: string; effort?: string }>;
    }
  | {
      kind: 'run_handoff';
      runId: string;
      tier: string;
      runBranch: string;
      targetBranch: string;
      lessonCandidates: Array<{ id: string; evidence: string; target: string; draftRule: string }>;
      prDraft: { title: string; body: string };
      cleanupPlan: {
        worktreesToRemove: string[];
        branchesToRemove: string[];
        rawPlanJson: Record<string, unknown>;
      };
    };

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
  lifecycleState: RunLifecycleState;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageRecord {
  id: string;
  projectId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'subagent';
  content: string;
  turnBlocks?: Array<{
    type: 'tool' | 'command' | 'diff' | 'text';
    title: string;
    content: string;
    filePath?: string;
    collapsed?: boolean;
  }>;
  decisionCard?: DecisionCardPayload & { id?: string; resolved?: boolean; resolution?: unknown };
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
