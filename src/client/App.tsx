import React, { useEffect, useState, useRef } from 'react';
import type {
  ChatMessageRecord,
  DecisionCardPayload,
  LiveBadgeState,
  RegisteredProject,
} from '../types.js';

export interface AppProps {
  apiBaseUrl?: string;
}

const KANBAN_COLUMNS = [
  'Ready',
  'Plan',
  'Implement',
  'Review',
  'Critic',
  'Integrate',
  'Done',
  'Blocked',
] as const;

const CLICKABLE_PATH_RE = /\b([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|py|md|json|css|html))\b/g;

export function App({ apiBaseUrl = '' }: AppProps): React.ReactElement {
  const [projects, setProjects] = useState<RegisteredProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; slug?: string }>>([]);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [alerts, setAlerts] = useState<
    Array<{
      id: string;
      projectId: string;
      projectName: string;
      sessionId: string;
      messageId: string;
      badgeState: LiveBadgeState;
      cardKind: string;
      summary: string;
    }>
  >([]);

  const [inspection, setInspection] = useState<{
    specs: Array<{ slug: string; title: string; status: string; path: string }>;
    issues: Array<{ ref: string; title: string; status: string; path: string }>;
    worktrees: Array<{
      path: string;
      branch: string;
      badgeState: LiveBadgeState;
      issueRef?: string;
      agents?: Array<{ id: string; role: string; badgeState: LiveBadgeState }>;
    }>;
    remediationCards: Array<{
      kind: string;
      title: string;
      description: string;
      remediation: string;
    }>;
  } | null>(null);

  const [activeView, setActiveView] = useState<'factory' | 'kanban' | 'setup' | 'settings'>(
    'factory',
  );
  const [paneMode, setPaneMode] = useState<'chat' | 'terminal'>('chat');
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [terminalBuffer, setTerminalBuffer] = useState<string>(
    '[gantry-harness] Interactive PTY ready.\r\n',
  );
  const [coordinatorInput, setCoordinatorInput] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [activeRunId, setActiveRunId] = useState<string>('');
  const [approvedSlug, setApprovedSlug] = useState<string | null>(null);
  const [steeringInput, setSteeringInput] = useState('');
  const [selectedSteeringIssue, setSelectedSteeringIssue] = useState<string>('');
  const [editInstruction, setEditInstruction] = useState('');
  const [grillingAnswers, setGrillingAnswers] = useState<Record<string, string>>({});
  const [selectedReplacementIdx, setSelectedReplacementIdx] = useState<number>(0);

  const [artifactDrawer, setArtifactDrawer] = useState<{
    path: string;
    content: string;
    diff: string;
  } | null>(null);

  const [kanbanRuns, setKanbanRuns] = useState<
    Array<{
      runId: string;
      finished: boolean;
      columns: Record<string, Array<{ ref: string; phase: string; operatorWaiting: boolean }>>;
    }>
  >([]);

  const [setupDiffPreview, setSetupDiffPreview] = useState<string>('');
  const [setupHostHarness, setSetupHostHarness] = useState<string>('opencode');
  const [discoveredModels, setDiscoveredModels] = useState<Array<{ id: string }>>([]);
  const [providerMode, setProviderMode] = useState<'sdk' | 'cli'>('cli');
  const [activeProvider, setActiveProvider] = useState<
    'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'cli'
  >('cli');
  const [providerApiKey, setProviderApiKey] = useState<string>('');
  const [pairingCode, setPairingCode] = useState<string>('');
  const [requiresRemotePairing, setRequiresRemotePairing] = useState<boolean>(false);
  const [enteredPairingCode, setEnteredPairingCode] = useState<string>('');
  const [authToken, setAuthToken] = useState<string>(() => {
    try {
      return typeof localStorage !== 'undefined' ? (localStorage.getItem('gantry_auth_token') ?? '') : '';
    } catch {
      return '';
    }
  });
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);

  const base = apiBaseUrl.replace(/\/$/, '');

  const apiFetch = async (urlPath: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers ?? {});
    if (authToken) {
      headers.set('Authorization', `Bearer ${authToken}`);
    }
    return fetch(`${base}${urlPath}`, { ...init, headers });
  };

  const loadWorkspaceState = async (): Promise<void> => {
    try {
      const res = await apiFetch('/api/workspace/state');
      if (res.status === 401) {
        setRequiresRemotePairing(true);
        return;
      }
      if (!res.ok) return;
      setRequiresRemotePairing(false);
      const data = await res.json();
      const projs: RegisteredProject[] = data.projects ?? [];
      setProjects(projs);
      const actProj = data.layout?.activeProjectId ?? projs[0]?.id ?? null;
      setActiveProjectId(actProj);
      setSessions(data.sessions ?? []);
      const actSess = data.layout?.activeSessionId ?? data.sessions?.[0]?.id ?? null;
      setActiveSessionId(actSess);
      setMessages(data.messages ?? []);

      const alertRes = await apiFetch('/api/alerts');
      if (alertRes.ok) {
        const alertData = await alertRes.json();
        setAlerts(alertData.alerts ?? []);
      }

      if (actProj) {
        const inspRes = await apiFetch(`/api/projects/${actProj}/inspect`);
        if (inspRes.ok) {
          setInspection(await inspRes.json());
        }
        const kbRes = await apiFetch(`/api/projects/${actProj}/kanban`);
        if (kbRes.ok) {
          const kbData = await kbRes.json();
          setKanbanRuns(kbData.runs ?? []);
        }
      }
    } catch {
      // Ignore network race on unmount
    }
  };

  useEffect(() => {
    void loadWorkspaceState();
    // Connect real-time WebSocket stream for live updates
    const wsBase = base.startsWith('http')
      ? base.replace(/^http/, 'ws')
      : typeof window !== 'undefined' && window.location?.host
        ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
        : '';
    if (!wsBase) return;
    const wsUrl = authToken ? `${wsBase}/?token=${encodeURIComponent(authToken)}` : wsBase;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (evt) => {
        try {
          const payload = JSON.parse(String(evt.data));
          if (payload.type === 'pane.output' && payload.chunk) {
            setTerminalBuffer((prev) => `${prev}${payload.chunk}`);
          } else {
            void loadWorkspaceState();
          }
        } catch {
          // ignore
        }
      };
    } catch {
      // ignore if WebSocket unavailable
    }
    return () => {
      if (ws) ws.close();
    };
  }, [apiBaseUrl, authToken]);

  useEffect(() => {
    if (paneMode !== 'terminal' || !terminalContainerRef.current) return;
    if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return;
    let disposed = false;
    void (async () => {
      try {
        const xtermMod = await import('@xterm/xterm');
        if (disposed || !terminalContainerRef.current) return;
        const term = new xtermMod.Terminal({ cols: 80, rows: 24 });
        term.open(terminalContainerRef.current);
        term.write(terminalBuffer);
      } catch {
        // Fallback when canvas is absent
      }
    })();
    return () => {
      disposed = true;
    };
  }, [paneMode]);

  const handleAddProject = async (): Promise<void> => {
    if (!newProjectPath.trim()) return;
    const res = await apiFetch(`/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newProjectPath.trim() }),
    });
    if (res.ok) {
      setNewProjectPath('');
      await loadWorkspaceState();
    }
  };

  const handleSelectProject = async (projectId: string, sessionId?: string): Promise<void> => {
    setActiveProjectId(projectId);
    if (sessionId) setActiveSessionId(sessionId);
    await apiFetch(`/api/workspace/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeProjectId: projectId,
        ...(sessionId ? { activeSessionId: sessionId } : {}),
      }),
    });
    await loadWorkspaceState();
  };

  const handleSelectSession = async (sessionId: string): Promise<void> => {
    if (!activeProjectId) return;
    setActiveSessionId(sessionId);
    await apiFetch(`/api/workspace/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeProjectId, activeSessionId: sessionId }),
    });
    await loadWorkspaceState();
  };

  const handleSpawnLauncher = async (
    launcher: 'claude' | 'codex' | 'opencode' | 'agy' | 'shell',
    worktreePath?: string,
  ): Promise<void> => {
    if (!activeProjectId) return;
    const paneId = `pane-${launcher}-${Date.now()}`;
    const res = await apiFetch(`/api/projects/${activeProjectId}/panes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paneId,
        launcher,
        worktreePath,
        mode: 'terminal',
      }),
    });
    if (res.ok) {
      const data = await res.json();
      setActivePaneId(data.pane.paneId);
      setTerminalBuffer(data.pane.terminalBuffer ?? '');
      setPaneMode('terminal');
    } else {
      setPaneMode('terminal');
    }
  };

  const handleToggleChatTerminal = async (): Promise<void> => {
    if (activeProjectId && activePaneId) {
      const res = await fetch(
        `${base}/api/projects/${activeProjectId}/panes/${activePaneId}/toggle`,
        { method: 'POST' },
      );
      if (res.ok) {
        const data = await res.json();
        setPaneMode(data.pane.mode);
        setTerminalBuffer(data.pane.terminalBuffer ?? terminalBuffer);
        return;
      }
    }
    setPaneMode((m) => (m === 'chat' ? 'terminal' : 'chat'));
  };

  const handleVirtualKey = async (keySeq: string): Promise<void> => {
    setTerminalBuffer((prev) => `${prev}${keySeq}`);
    if (activeProjectId && activePaneId) {
      await apiFetch(`/api/projects/${activeProjectId}/panes/${activePaneId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: keySeq }),
      });
    }
  };

  const handleSendCoordinatorInput = async (): Promise<void> => {
    if (!activeProjectId || !coordinatorInput.trim()) return;
    const text = coordinatorInput.trim();
    setCoordinatorInput('');

    if (text.startsWith('/plan')) {
      const goal = text.replace(/^\/plan\s*/, '').trim() || 'New feature';
      const res = await apiFetch(`/api/projects/${activeProjectId}/plan/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal, sessionId: activeSessionId }),
      });
      if (res.ok) {
        const out = await res.json();
        setActiveRunId(out.runId);
        await loadWorkspaceState();
      }
      return;
    }

    if (text.startsWith('/run')) {
      const scope = text.replace(/^\/run\s*/, '').trim() || approvedSlug || 'all';
      const res = await apiFetch(`/api/projects/${activeProjectId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, sessionId: activeSessionId }),
      });
      if (res.ok) {
        const out = await res.json();
        setActiveRunId(out.runId);
        await loadWorkspaceState();
      }
      return;
    }

    await apiFetch(`/api/projects/${activeProjectId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: activeSessionId, prompt: text }),
    });
    await loadWorkspaceState();
  };

  const handleAnswerGrilling = async (
    card: Extract<DecisionCardPayload, { kind: 'grilling_round' }>,
  ): Promise<void> => {
    if (!activeProjectId) return;
    const answers: Record<string, string> = {};
    for (const q of card.questions) {
      answers[q.id] = grillingAnswers[q.id] ?? q.recommendedAnswer;
    }
    await apiFetch(`/api/projects/${activeProjectId}/plan/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: card.slug,
        runId: activeRunId,
        sessionId: activeSessionId,
        roundNumber: card.roundNumber,
        finishGrilling: true,
        answers,
      }),
    });
    await loadWorkspaceState();
  };

  const handleRefineSpec = async (
    card: Extract<DecisionCardPayload, { kind: 'spec_blocked' }>,
  ): Promise<void> => {
    if (!activeProjectId) return;
    await apiFetch(`/api/projects/${activeProjectId}/plan/refine-spec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: card.slug,
        sessionId: activeSessionId,
        amendment: editInstruction || 'Clarified retry and verification constraints.',
      }),
    });
    setEditInstruction('');
    await loadWorkspaceState();
  };

  const handleEditDraftIssues = async (
    slug: string,
    action: 'split' | 'merge' | 'reorder' | 'refine',
    targetRef?: string,
  ): Promise<void> => {
    if (!activeProjectId) return;
    await apiFetch(`/api/projects/${activeProjectId}/plan/edit-issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug,
        sessionId: activeSessionId,
        action,
        targetRef,
        instruction: editInstruction || 'Additional vertical slice',
      }),
    });
    setEditInstruction('');
    await loadWorkspaceState();
  };

  const handleApprovePlan = async (slug: string): Promise<void> => {
    if (!activeProjectId) return;
    const res = await apiFetch(`/api/projects/${activeProjectId}/plan/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug,
        runId: activeRunId,
        sessionId: activeSessionId,
      }),
    });
    if (res.ok) {
      setApprovedSlug(slug);
      await loadWorkspaceState();
    }
  };

  const handleStartRun = async (scope: string): Promise<void> => {
    if (!activeProjectId) return;
    const res = await apiFetch(`/api/projects/${activeProjectId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, sessionId: activeSessionId }),
    });
    if (res.ok) {
      const out = await res.json();
      setActiveRunId(out.runId);
      await loadWorkspaceState();
    }
  };

  const handleTakeoverWorktree = async (issueRef: string, worktreePath: string): Promise<void> => {
    if (!activeProjectId || !activeRunId) return;
    const res = await apiFetch(`/api/projects/${activeProjectId}/runs/${activeRunId}/takeover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueRef, worktreePath, launcher: 'shell' }),
    });
    if (res.ok) {
      const data = await res.json();
      setActivePaneId(data.pane.paneId);
      setTerminalBuffer(data.pane.terminalBuffer ?? '');
      setPaneMode('terminal');
    }
  };

  const handleResumeTakeover = async (issueRef: string): Promise<void> => {
    if (!activeProjectId || !activeRunId) return;
    await apiFetch(`/api/projects/${activeProjectId}/runs/${activeRunId}/resume-takeover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueRef, sessionId: activeSessionId }),
    });
    await loadWorkspaceState();
  };

  const handleRecoverIssue = async (
    card: Extract<DecisionCardPayload, { kind: 'issue_recovery' }>,
  ): Promise<void> => {
    if (!activeProjectId) return;
    const replacement =
      card.availableReplacements[selectedReplacementIdx] ??
      card.availableReplacements[0] ??
      card.currentSelection;
    await apiFetch(`/api/projects/${activeProjectId}/runs/${card.runId}/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        issueRef: card.issueRef,
        role: 'implement',
        replacement,
        sessionId: activeSessionId,
      }),
    });
    await loadWorkspaceState();
  };

  const handleDecideLesson = async (
    runId: string,
    lesson: { id: string; target: string; draftRule: string },
    decision: 'accept' | 'dismiss',
  ): Promise<void> => {
    if (!activeProjectId) return;
    await apiFetch(`/api/projects/${activeProjectId}/runs/${runId}/lessons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lessonId: lesson.id,
        decision,
        targetFile: lesson.target,
        draftRule: lesson.draftRule,
      }),
    });
    await loadWorkspaceState();
  };

  const handleCreateDraftPr = async (
    card: Extract<DecisionCardPayload, { kind: 'run_handoff' }>,
  ): Promise<void> => {
    if (!activeProjectId) return;
    await apiFetch(`/api/projects/${activeProjectId}/runs/${card.runId}/pr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: card.prDraft.title,
        body: card.prDraft.body,
        runBranch: card.runBranch,
        targetBranch: card.targetBranch,
      }),
    });
  };

  const handleAuthorizeCleanup = async (
    card: Extract<DecisionCardPayload, { kind: 'run_handoff' }>,
  ): Promise<void> => {
    if (!activeProjectId) return;
    await apiFetch(`/api/projects/${activeProjectId}/runs/${card.runId}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawPlanJson: card.cleanupPlan.rawPlanJson }),
    });
    await loadWorkspaceState();
  };

  const handleOpenArtifact = async (relPath: string): Promise<void> => {
    if (!activeProjectId) return;
    const res = await fetch(
      `${base}/api/projects/${activeProjectId}/artifacts?path=${encodeURIComponent(relPath)}&diff=true`,
    );
    if (res.ok) {
      setArtifactDrawer(await res.json());
    }
  };

  const handleSaveArtifact = async (): Promise<void> => {
    if (!activeProjectId || !artifactDrawer) return;
    await apiFetch(`/api/projects/${activeProjectId}/artifacts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: artifactDrawer.path, content: artifactDrawer.content }),
    });
    await handleOpenArtifact(artifactDrawer.path);
  };

  const handleSteer = async (mode: 'queue' | 'send_now'): Promise<void> => {
    if (!activeProjectId || !activeRunId || !steeringInput.trim()) return;
    const targetIssue =
      selectedSteeringIssue || inspection?.issues?.[0]?.ref || 'slice#01';
    await apiFetch(`/api/projects/${activeProjectId}/runs/${activeRunId}/steer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        issueRef: targetIssue,
        mode,
        instruction: steeringInput.trim(),
      }),
    });
    setSteeringInput('');
  };

  const buildProposedPolicy = (): Record<string, unknown> => ({
    execution: {
      hostHarness: setupHostHarness,
      roles: {
        plan: { harness: setupHostHarness, model: 'google/gemini-4-argon', effort: 'high' },
        implement: { harness: setupHostHarness, model: 'google/gemini-4-argon', effort: 'high' },
        review: { harness: setupHostHarness, model: 'openai/gpt-6.1-sol', effort: 'high' },
        critic: { harness: setupHostHarness, model: 'openai/gpt-6.1-sol', effort: 'high' },
      },
    },
    git: {
      target: 'main',
      prefix: 'gantry/',
      issueBranch: '{prefix}{spec}-{number:02d}',
    },
    checks: [{ name: 'browser-validation', command: 'bun run test', mode: 'absolute' }],
    hooks: { record: ['git commit'], deny: ['git push --force'] },
    caveman: true,
  });

  const handlePreviewSetup = async (): Promise<void> => {
    if (!activeProjectId) return;
    const res = await apiFetch(`/api/projects/${activeProjectId}/setup/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy: buildProposedPolicy() }),
    });
    if (res.ok) {
      const data = await res.json();
      setSetupDiffPreview(data.diff ?? '');
    }
  };

  const handleApplySetup = async (scope: 'repository' | 'personal'): Promise<void> => {
    if (!activeProjectId) return;
    const policy = buildProposedPolicy();
    await apiFetch(`/api/projects/${activeProjectId}/setup/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope,
        policy,
        hostHarness: setupHostHarness,
        roles: (policy.execution as { roles: Record<string, unknown> }).roles,
      }),
    });
    await loadWorkspaceState();
  };

  const cleanTerminalText = (raw: string): string => {
    return raw
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\[\?[0-9]+[hl]/g, '')
      .replace(/\]0;[^\r\n]*/g, '')
      .replace(/\[[0-9;]+m/g, '');
  };

  const renderClickableText = (text: string): React.ReactNode => {
    const cleaned = cleanTerminalText(text);
    const matches = Array.from(cleaned.matchAll(CLICKABLE_PATH_RE)).map((m) => m[1]);
    if (matches.length === 0) return cleaned;
    return (
      <span>
        {cleaned}{' '}
        {Array.from(new Set(matches)).map((p) => (
          <button
            key={p}
            className="btn-file-link"
            data-testid={`file-link-${p}`}
            onClick={() => void handleOpenArtifact(p)}
            style={{ marginLeft: 4 }}
          >
            {p}
          </button>
        ))}
      </span>
    );
  };

  const renderDecisionCard = (card: DecisionCardPayload): React.ReactElement => {
    if (card.kind === 'grilling_round') {
      return (
        <div className="decision-card" data-testid="decision-card-grilling_round">
          <h4>
            Socratic Gate Grilling — {card.slug} (Round {card.roundNumber})
          </h4>
          {card.questions.map((q) => (
            <div key={q.id} style={{ marginBottom: 10 }}>
              <strong>{q.title}</strong>
              <p>{q.body}</p>
              {q.options && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  {q.options.map((opt) => (
                    <button
                      key={opt.label}
                      onClick={() =>
                        setGrillingAnswers((prev) => ({ ...prev, [q.id]: opt.description }))
                      }
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
              <input
                value={grillingAnswers[q.id] ?? q.recommendedAnswer}
                onChange={(e) =>
                  setGrillingAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                }
                style={{ width: '100%' }}
              />
            </div>
          ))}
          <button
            data-testid="submit-grilling-btn"
            onClick={() => void handleAnswerGrilling(card)}
          >
            Accept Answers & Synthesize Spec
          </button>
        </div>
      );
    }

    if (card.kind === 'spec_blocked') {
      return (
        <div className="decision-card" data-testid="decision-card-spec_blocked">
          <h4>Spec Blocked ({card.source})</h4>
          <ul>
            {card.findings.map((f, i) => (
              <li key={i}>
                <code>{f.quote}</code>: {f.reason}
              </li>
            ))}
          </ul>
          <input
            placeholder="Enter Spec refinement..."
            value={editInstruction}
            onChange={(e) => setEditInstruction(e.target.value)}
          />
          <button data-testid="refine-spec-btn" onClick={() => void handleRefineSpec(card)}>
            Refine & Re-Validate Spec
          </button>
        </div>
      );
    }

    if (card.kind === 'plan_approval') {
      return (
        <div className="decision-card" data-testid="decision-card-plan_approval">
          <h4>Planning Approval Card — {card.slug}</h4>
          <div>
            Spec:{' '}
            <button
              data-testid={`file-link-${card.specPath}`}
              onClick={() => void handleOpenArtifact(card.specPath)}
            >
              {card.specPath}
            </button>
          </div>
          <div>
            Plan Critic Verdict: {card.criticVerdict.acceptable ? 'Acceptable' : 'Refuted'}
          </div>
          <div>
            Waves: {card.waves.map((w, idx) => `Wave ${idx}: [${w.join(', ')}]`).join(' → ')}
          </div>
          <ul>
            {card.issues.map((iss) => (
              <li key={iss.ref}>
                <strong>{iss.ref}</strong>: {iss.title} ({iss.estimatedTokens}/{iss.budgetTokens}{' '}
                tokens {iss.overBudget ? '[OVER BUDGET]' : '[OK]'})
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              placeholder="Split/refine instruction..."
              value={editInstruction}
              onChange={(e) => setEditInstruction(e.target.value)}
            />
            <button
              data-testid="edit-issues-btn"
              onClick={() => void handleEditDraftIssues(card.slug, 'split', card.issues[0]?.ref)}
            >
              Split Slice
            </button>
            <button
              data-testid="approve-plan-btn"
              onClick={() => void handleApprovePlan(card.slug)}
            >
              Approve Plan
            </button>
          </div>
        </div>
      );
    }

    if (card.kind === 'issue_recovery') {
      return (
        <div className="decision-card" data-testid="decision-card-issue_recovery">
          <h4>Recovery Card — {card.issueRef}</h4>
          <div>Reason: {card.failureReason}</div>
          <div>Corrections Spent: {card.correctionsSpent}</div>
          <div>Preserved Worktree: {card.worktree}</div>
          <select
            value={selectedReplacementIdx}
            onChange={(e) => setSelectedReplacementIdx(Number(e.target.value))}
          >
            {card.availableReplacements.map((rep, idx) => (
              <option key={idx} value={idx}>
                {rep.harness} / {rep.model} {rep.effort ? `(${rep.effort})` : ''}
              </option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              data-testid="takeover-btn"
              onClick={() => void handleTakeoverWorktree(card.issueRef, card.worktree)}
            >
              Takeover in Terminal
            </button>
            <button
              data-testid="resume-takeover-btn"
              onClick={() => void handleResumeTakeover(card.issueRef)}
            >
              Resume Gantry Pipeline
            </button>
            <button
              data-testid="recover-issue-btn"
              onClick={() => void handleRecoverIssue(card)}
            >
              Apply Role Replacement & Resume Run
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="decision-card" data-testid="decision-card-run_handoff">
        <h4>Run Handoff — {card.runId}</h4>
        <div>
          Branch: {card.runBranch} → {card.targetBranch} (Tier: {card.tier})
        </div>
        {card.lessonCandidates.length > 0 && (
          <div>
            <h5>Lesson Candidates</h5>
            {card.lessonCandidates.map((lc) => (
              <div key={lc.id}>
                <span>
                  {lc.draftRule} ({lc.target})
                </span>
                <button
                  data-testid={`accept-lesson-${lc.id}`}
                  onClick={() => void handleDecideLesson(card.runId, lc, 'accept')}
                >
                  Accept
                </button>
                <button onClick={() => void handleDecideLesson(card.runId, lc, 'dismiss')}>
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        )}
        <div>
          <h5>Draft Pull Request</h5>
          <pre>{card.prDraft.body}</pre>
          <button data-testid="create-pr-btn" onClick={() => void handleCreateDraftPr(card)}>
            Open Draft PR (gh)
          </button>
        </div>
        <div>
          <h5>Cleanup Plan</h5>
          <div>Worktrees to remove: {card.cleanupPlan.worktreesToRemove.join(', ') || 'None'}</div>
          <div>Branches to remove: {card.cleanupPlan.branchesToRemove.join(', ') || 'None'}</div>
          <button
            data-testid="authorize-cleanup-btn"
            onClick={() => void handleAuthorizeCleanup(card)}
          >
            Authorize Cleanup (cleanup.py --yes)
          </button>
        </div>
      </div>
    );
  };

  const handleVerifyPairingCode = async (): Promise<void> => {
    const res = await apiFetch(`/api/auth/pair/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: enteredPairingCode.trim() }),
    });
    if (res.ok) {
      const data = await res.json();
      setAuthToken(data.token);
      try {
        localStorage.setItem('gantry_auth_token', data.token);
      } catch {
        // ignore
      }
      setRequiresRemotePairing(false);
    }
  };

  if (requiresRemotePairing) {
    return (
      <div
        data-testid="remote-pairing-screen"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: 12,
        }}
      >
        <h2>Gantry Harness — Remote Tailscale / LAN Pairing</h2>
        <p>Enter the 6-digit One-Time Pairing Code displayed in your terminal or Settings:</p>
        <input
          data-testid="pairing-code-input"
          placeholder="6-digit code"
          value={enteredPairingCode}
          onChange={(e) => setEnteredPairingCode(e.target.value)}
        />
        <button data-testid="pairing-verify-btn" onClick={() => void handleVerifyPairingCode()}>
          Verify & Connect
        </button>
      </div>
    );
  }

  return (
    <div className="harness-shell industrial-grid">
      <aside className="sidebar" data-testid="sidebar">
        <div className="brand-header">
          <div className="brand-mark">
            <span className="diamond" />
            <span>
              Gantry <span style={{ color: 'var(--amber-accent)' }}>//</span> Harness
            </span>
          </div>
          <span className="telemetry-tag">RIG ONLINE</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            placeholder="/path/to/repo"
            value={newProjectPath}
            onChange={(e) => setNewProjectPath(e.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button
            className="btn-primary"
            data-testid="add-project-btn"
            onClick={() => void handleAddProject()}
          >
            + Add Project
          </button>
        </div>

        <div>
          <h4>Projects</h4>
          {projects.map((p) => (
            <div
              key={p.id}
              className={`project-card ${p.id === activeProjectId ? 'project-card-active' : ''}`}
              onClick={() => void handleSelectProject(p.id)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{p.name}</strong>{' '}
                <span className={`badge badge-${p.badgeState.replace(/\s+/g, '-')}`}>
                  {p.badgeState}
                </span>
              </div>
              {p.id === activeProjectId && inspection && (
                <div style={{ paddingLeft: 6, marginTop: 6, fontSize: 12, color: '#b1bac4' }}>
                  <div>Worktrees ({inspection.worktrees.length})</div>
                  {inspection.worktrees.map((wt) => (
                    <div key={wt.path} style={{ marginTop: 2 }}>
                      ↳ {wt.branch} [{wt.badgeState}]
                      {wt.issueRef && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleTakeoverWorktree(wt.issueRef!, wt.path);
                          }}
                          style={{ marginLeft: 6, padding: '2px 6px', fontSize: 11 }}
                        >
                          Takeover
                        </button>
                      )}
                    </div>
                  ))}
                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>Artifacts:</span>
                    <button
                      className="btn-file-link"
                      data-testid="file-link-src/app.ts"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleOpenArtifact('src/app.ts');
                      }}
                    >
                      src/app.ts
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <div>
          <h4>Sessions</h4>
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => void handleSelectSession(s.id)}
              style={{
                cursor: 'pointer',
                padding: '6px 8px',
                borderRadius: 6,
                background: s.id === activeSessionId ? 'rgba(47, 129, 247, 0.12)' : 'transparent',
                color: s.id === activeSessionId ? '#79c0ff' : '#b1bac4',
              }}
            >
              • {s.title}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button
            className={`btn-nav ${activeView === 'factory' ? 'btn-nav-active' : ''}`}
            data-testid="open-factory-btn"
            onClick={() => setActiveView('factory')}
          >
            Factory Chat & PTY
          </button>
          <button
            className={`btn-nav ${activeView === 'kanban' ? 'btn-nav-active' : ''}`}
            data-testid="open-kanban-btn"
            onClick={() => setActiveView('kanban')}
          >
            Embedded Kanban
          </button>
          <button
            className={`btn-nav ${activeView === 'setup' ? 'btn-nav-active' : ''}`}
            data-testid="open-setup-btn"
            onClick={() => setActiveView('setup')}
          >
            Gantry Setup
          </button>
          <button
            className={`btn-nav ${activeView === 'settings' ? 'btn-nav-active' : ''}`}
            data-testid="open-settings-btn"
            onClick={() => setActiveView('settings')}
          >
            Global AI Settings
          </button>
        </div>
      </aside>

      <main className="main-area">
        {alerts.length > 0 && (
          <div
            className="alert-banner"
            data-testid="alert-banner"
            onClick={() => {
              const first = alerts[0];
              void handleSelectProject(first.projectId, first.sessionId);
              setActiveView('factory');
            }}
          >
            <span>
              Alert: <strong>{alerts[0].projectName}</strong> is{' '}
              <strong>{alerts[0].badgeState}</strong> ({alerts[0].cardKind})
            </span>
            <span>Jump to Decision Card →</span>
          </div>
        )}

        <header className="top-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: '#7d8590', fontSize: 12, fontWeight: 600 }}>Launchers:</span>
            {(['claude', 'codex', 'opencode', 'agy', 'shell'] as const).map((l) => (
              <button
                key={l}
                className="btn-launcher"
                data-testid={`launcher-${l}`}
                onClick={() => void handleSpawnLauncher(l)}
              >
                +{l}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {approvedSlug && (
              <button
                className="btn-success"
                data-testid="start-run-btn"
                onClick={() => void handleStartRun(approvedSlug)}
              >
                Start Run ({approvedSlug})
              </button>
            )}
            <button
              className="btn-primary"
              data-testid="chat-terminal-toggle"
              onClick={() => void handleToggleChatTerminal()}
            >
              Chat ⇄ Terminal ({paneMode})
            </button>
          </div>
        </header>

        {activeView === 'factory' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {paneMode === 'chat' ? (
              <div style={{ flex: 1, padding: 16, overflowY: 'auto' }} data-testid="chat-view">
                {messages.map((m) => (
                  <div key={m.id} style={{ marginBottom: 12 }}>
                    <div>
                      <strong>{m.role}:</strong> {renderClickableText(m.content)}
                    </div>
                    {m.decisionCard && renderDecisionCard(m.decisionCard)}
                  </div>
                ))}
              </div>
            ) : (
              <div
                style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
                data-testid="terminal-view"
              >
                <div className="terminal-surface">
                  <pre>{renderClickableText(terminalBuffer)}</pre>
                  <div ref={terminalContainerRef} style={{ display: 'none' }} />
                </div>
                <div className="virtual-keybar" data-testid="virtual-keybar">
                  <button className="btn-key" onClick={() => void handleVirtualKey('\x1b')}>
                    esc
                  </button>
                  <button className="btn-key" onClick={() => void handleVirtualKey('\t')}>
                    tab
                  </button>
                  <button className="btn-key" onClick={() => void handleVirtualKey('\x03')}>
                    ^C
                  </button>
                  <button className="btn-key" onClick={() => void handleVirtualKey('\x1b[A')}>
                    ↑
                  </button>
                  <button className="btn-key" onClick={() => void handleVirtualKey('\x1b[B')}>
                    ↓
                  </button>
                  <button className="btn-key" onClick={() => void handleVirtualKey('\x1b[D')}>
                    ←
                  </button>
                  <button className="btn-key" onClick={() => void handleVirtualKey('\x1b[C')}>
                    →
                  </button>
                </div>
              </div>
            )}

            <div
              data-testid="steering-bar"
              style={{
                display: 'flex',
                gap: 8,
                padding: '10px 18px',
                background: 'var(--obsidian-950)',
                borderTop: '1px solid var(--obsidian-700)',
              }}
            >
              <input
                placeholder="Issue ref (e.g. slice#01)"
                value={selectedSteeringIssue}
                onChange={(e) => setSelectedSteeringIssue(e.target.value)}
                style={{ width: 160 }}
              />
              <input
                placeholder="Steer active subagent..."
                value={steeringInput}
                onChange={(e) => setSteeringInput(e.target.value)}
                style={{ flex: 1 }}
              />
              <button data-testid="steer-queue-btn" onClick={() => void handleSteer('queue')}>
                Queue (Next Turn)
              </button>
              <button
                className="btn-primary"
                data-testid="steer-send-now-btn"
                onClick={() => void handleSteer('send_now')}
              >
                Send Now (Steer)
              </button>
            </div>

            <div
              style={{
                display: 'flex',
                gap: 8,
                padding: '12px 18px',
                background: 'var(--obsidian-950)',
                borderTop: '1px solid var(--obsidian-700)',
              }}
            >
              <input
                data-testid="coordinator-input"
                placeholder="Ask Coordinator or type /plan <goal>, /run <scope>..."
                value={coordinatorInput}
                onChange={(e) => setCoordinatorInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSendCoordinatorInput();
                }}
                style={{ flex: 1 }}
              />
              <button
                className="btn-primary"
                data-testid="coordinator-send-btn"
                onClick={() => void handleSendCoordinatorInput()}
              >
                Send
              </button>
            </div>
          </div>
        )}

        {activeView === 'kanban' && (
          <div data-testid="kanban-board" style={{ flex: 1, overflow: 'auto' }}>
            <div className="kanban-grid">
              {KANBAN_COLUMNS.map((col) => (
                <div key={col} className="kanban-col" data-testid={`kanban-col-${col}`}>
                  <h4>{col}</h4>
                  {kanbanRuns.map((run) =>
                    (run.columns[col] ?? []).map((item) => (
                      <div
                        key={`${run.runId}-${item.ref}`}
                        style={{
                          padding: 6,
                          border: '1px solid #30363d',
                          borderRadius: 4,
                          marginBottom: 6,
                        }}
                      >
                        <div>
                          <strong>{item.ref}</strong> ({run.runId})
                        </div>
                        {item.operatorWaiting && <span>Awaiting Operator</span>}
                      </div>
                    )),
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {activeView === 'setup' && (
          <div data-testid="setup-panel" style={{ padding: 16, overflowY: 'auto' }}>
            <h3>Gantry Repository Setup & Role Execution</h3>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                data-testid="bootstrap-skills-btn"
                onClick={async () => {
                  if (!activeProjectId) return;
                  await apiFetch(`/api/projects/${activeProjectId}/bootstrap`, {
                    method: 'POST',
                  });
                  await loadWorkspaceState();
                }}
              >
                Install / Update Gantry Skills
              </button>
              <button
                data-testid="discover-models-btn"
                onClick={async () => {
                  if (!activeProjectId) return;
                  const res = await fetch(
                    `${base}/api/projects/${activeProjectId}/discovery?harness=${setupHostHarness}`,
                  );
                  if (res.ok) {
                    const data = await res.json();
                    setDiscoveredModels(data.models ?? []);
                  }
                }}
              >
                Discover Verified Models
              </button>
            </div>
            {discoveredModels.length > 0 && (
              <div>Discovered: {discoveredModels.map((m) => m.id).join(', ')}</div>
            )}
            <div>
              <label>
                Host Harness:{' '}
                <select
                  value={setupHostHarness}
                  onChange={(e) => setSetupHostHarness(e.target.value)}
                >
                  <option value="opencode">opencode</option>
                  <option value="claude-code">claude-code</option>
                  <option value="codex">codex</option>
                  <option value="antigravity">antigravity</option>
                </select>
              </label>
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <button data-testid="preview-setup-btn" onClick={() => void handlePreviewSetup()}>
                Preview Policy Diff
              </button>
              <button
                data-testid="apply-repo-setup-btn"
                onClick={() => void handleApplySetup('repository')}
              >
                Apply Repository Policy (setup.py)
              </button>
              <button
                data-testid="apply-personal-setup-btn"
                onClick={() => void handleApplySetup('personal')}
              >
                Save Personal Profile (--personal)
              </button>
            </div>
            {setupDiffPreview && (
              <pre data-testid="setup-diff-preview" style={{ marginTop: 12 }}>
                {setupDiffPreview}
              </pre>
            )}
          </div>
        )}

        {activeView === 'settings' && (
          <div data-testid="settings-panel" style={{ padding: 16 }}>
            <h3>Global AI Connection & Remote Pairing</h3>
            <div style={{ marginBottom: 12 }}>
              <label>
                Mode:{' '}
                <select
                  value={providerMode}
                  onChange={(e) => setProviderMode(e.target.value as 'sdk' | 'cli')}
                >
                  <option value="cli">Local Harness CLI Bridge</option>
                  <option value="sdk">Direct SDK / API</option>
                </select>
              </label>
              <label style={{ marginLeft: 12 }}>
                Provider:{' '}
                <select
                  value={activeProvider}
                  onChange={(e) => setActiveProvider(e.target.value as typeof activeProvider)}
                >
                  <option value="cli">CLI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="openrouter">OpenRouter</option>
                </select>
              </label>
              <input
                type="password"
                placeholder="API Key"
                value={providerApiKey}
                onChange={(e) => setProviderApiKey(e.target.value)}
                style={{ marginLeft: 12 }}
              />
              <button
                data-testid="save-provider-settings-btn"
                onClick={async () => {
                  await apiFetch(`/api/settings/providers`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      mode: providerMode,
                      activeProvider,
                      providers: {
                        [activeProvider]: { apiKey: providerApiKey },
                      },
                    }),
                  });
                }}
              >
                Save Provider Settings
              </button>
            </div>
            <button
              onClick={async () => {
                const res = await apiFetch(`/api/auth/pair/generate`, { method: 'POST' });
                if (res.ok) {
                  const data = await res.json();
                  setPairingCode(data.code);
                }
              }}
            >
              Generate One-Time Pairing Code
            </button>
            {pairingCode && <div data-testid="pairing-code-display">Code: {pairingCode}</div>}
          </div>
        )}

        {artifactDrawer && (
          <div
            data-testid="artifact-drawer"
            style={{
              borderTop: '2px solid var(--amber-glow)',
              background: 'var(--obsidian-950)',
              padding: 14,
              maxHeight: '35vh',
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>Artifact & Diff Viewer: {artifactDrawer.path}</strong>
              <div>
                <button data-testid="save-artifact-btn" onClick={() => void handleSaveArtifact()}>
                  Save Artifact
                </button>
                <button onClick={() => setArtifactDrawer(null)}>Close</button>
              </div>
            </div>
            <textarea
              data-testid="artifact-editor"
              value={artifactDrawer.content}
              onChange={(e) =>
                setArtifactDrawer((prev) => (prev ? { ...prev, content: e.target.value } : null))
              }
              style={{ width: '100%', minHeight: 80 }}
            />
            {artifactDrawer.diff && (
              <div>
                <h5>Git Diff</h5>
                <pre>{artifactDrawer.diff}</pre>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
