import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useActionFeedback } from './useActionFeedback.js';
import { FileViewerDialog } from './FileViewerDialog.js';
import { FileTree, type FileTreeEntry } from './FileTree.js';
import type { ExecutionSettings, RoleSelection } from '../types.js';
import type { ManagedPane } from '../server/ptyManager.js';
import type { PreparedGantryCommand } from '../types.js';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { TerminalSettings, TerminalEnvironment } from '../types.js';
import { SettingsDialog, type SettingsTab } from './SettingsDialog.js';
import { SystemFontSelect } from './SystemFontSelect.js';
import { BoardView } from './BoardView.js';
import { EXECUTION_HOSTS, ModelSelect, discoveryHarness, type CatalogModel } from './ModelSelect.js';
import { NO_PACK_EXPLANATION, coerceBoard, overlaysFromKanban, unavailableBoard, type BoardSnapshot } from '../boardModel.js';
import type {
  ChatMessageRecord,
  DecisionCardPayload,
  LiveBadgeState,
  RegisteredProject,
} from '../types.js';

export interface AppProps {
  apiBaseUrl?: string;
}

declare global {
  interface Window {
    gantryDesktop?: { platform: string; chooseDirectory: () => Promise<string | null> };
  }
}

const STATUS_LABELS: Record<string, string> = { working: 'Em execução', 'needs input': 'Aguardando você', done: 'Concluído', blocked: 'Bloqueado', idle: 'Pronto' };
const PHASE_LABELS: Record<string, string> = { idle: 'Pronto para começar', bootstrapping_skills: 'Preparando Gantry', setup_review: 'Revisando configuração', grilling_interview: 'Definindo o objetivo', spec_validation: 'Validando especificação', requirement_review: 'Revisando requisitos', slicing_and_critique: 'Preparando tarefas', awaiting_plan_approval: 'Aguardando aprovação do plano', round_preflight: 'Verificando execução', round_executing: 'Executando tarefas', awaiting_recovery_decision: 'Aguardando recuperação', awaiting_handoff_decisions: 'Aguardando revisão da entrega', completed: 'Execução concluída' };

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
    policy?: { execution?: ExecutionSettings; [key: string]: unknown };
    operatorProfile?: ExecutionSettings;
    skillPack?: { found: boolean };
    hasTrackedPolicy?: boolean;
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

  const [activeView, setActiveView] = useState<'factory' | 'files' | 'board'>('board');
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [boardGeneration, setBoardGeneration] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('terminal');
  const openSettings = (tab: SettingsTab) => { setSettingsTab(tab); setSettingsOpen(true); };
  const [terminalSettings, setTerminalSettings] = useState<TerminalSettings>({ fontFamily: 'Menlo, Consolas, monospace', fontSize: 13, shell: 'system' });
  const [terminalDraft, setTerminalDraft] = useState(terminalSettings);
  const [terminalEnvironment, setTerminalEnvironment] = useState<TerminalEnvironment | null>(null);
  const terminalSettingsLoaded = useRef(false);
  const terminalAppearance = useRef(terminalSettings);
  terminalAppearance.current = terminalSettings;
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [paneMode, setPaneMode] = useState<'chat' | 'terminal'>('terminal');
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [terminalBuffer, setTerminalBuffer] = useState<string>('');
  const [coordinatorInput, setCoordinatorInput] = useState('');
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [newProjectPath, setNewProjectPath] = useState('');
  const [activeRunId, setActiveRunId] = useState<string>('');
  const [approvedSlug, setApprovedSlug] = useState<string | null>(null);
  const [steeringInput, setSteeringInput] = useState('');
  const [selectedSteeringIssue, setSelectedSteeringIssue] = useState<string>('');
  const [editInstruction, setEditInstruction] = useState('');
  const [grillingAnswers, setGrillingAnswers] = useState<Record<string, string>>({});
  const [selectedReplacementIdx, setSelectedReplacementIdx] = useState<number>(0);

  const [artifactDrawer, setArtifactDrawer] = useState<{
    projectId: string;
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
  const [projectSettingsId, setProjectSettingsId] = useState<string | null>(null);
  const [setupHostHarness, setSetupHostHarness] = useState<string>('opencode');
  const [globalHost, setGlobalHost] = useState('');
  const [globalRoles, setGlobalRoles] = useState<Record<string, RoleSelection>>({});
  const globalExecutionLoaded = useRef(false);
  const [modelsByHarness, setModelsByHarness] = useState<Record<string, CatalogModel[]>>({});
  const [catalogLoading, setCatalogLoading] = useState<Record<string, boolean>>({});
  const [catalogErrors, setCatalogErrors] = useState<Record<string, string>>({});
  const catalogRequests = useRef(new Set<string>());
  const [roleSelections, setRoleSelections] = useState<Record<string, RoleSelection>>({});
  const setupProjectLoaded = useRef<string | null>(null);
  const { feedback, pendingActions, withFeedback, reportError, dismissFeedback } = useActionFeedback();
  const [terminalInput, setTerminalInput] = useState('');
  const [panes, setPanes] = useState<ManagedPane[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 760);
  const [wideWorkspace, setWideWorkspace] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 760);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [preparedCommand, setPreparedCommand] = useState<(PreparedGantryCommand & { projectId: string; sessionId: string | null }) | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
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
  const terminalRef = useRef<Terminal | null>(null);
  const terminalWrittenLength = useRef(0);
  const selectedPane = useRef({ projectId: activeProjectId, paneId: activePaneId, sessionId: activeSessionId });
  selectedPane.current = { projectId: activeProjectId, paneId: activePaneId, sessionId: activeSessionId };
  const workspaceLoading = useRef(false);
  const workspaceReloadRequested = useRef(false);
  const workspaceGeneration = useRef(0);

  const base = apiBaseUrl.replace(/\/$/, '');

  const apiFetch = useCallback(async (urlPath: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers ?? {});
    if (authToken) {
      headers.set('Authorization', `Bearer ${authToken}`);
    }
    let response: Response;
    try {
      response = await fetch(`${base}${urlPath}`, { ...init, headers });
    } catch {
      throw new Error('Não foi possível acessar o servidor. Verifique se bun start está em execução e tente novamente.');
    }
    if (response.status === 401 && urlPath !== '/api/auth/pair/verify') {
      setRequiresRemotePairing(true);
    }
    if (!response.ok) {
      const data = await response.clone().json().catch(() => ({}));
      throw new Error(data.error ?? `A solicitação falhou (HTTP ${response.status}). Tente novamente.`);
    }
    return response;
  }, [base, authToken]);

  const ensureModelCatalog = useCallback(async (host: string) => {
    const harness = discoveryHarness(host);
    if (!activeProjectId || !harness || catalogRequests.current.has(harness)) return;
    catalogRequests.current.add(harness);
    setCatalogLoading((current) => ({ ...current, [harness]: true }));
    try {
      const response = await apiFetch(`/api/projects/${activeProjectId}/discovery?harness=${encodeURIComponent(harness)}`);
      const data = await response.json();
      const models = Array.isArray(data.models) ? data.models as CatalogModel[] : [];
      setModelsByHarness((current) => ({ ...current, [harness]: models }));
      setCatalogErrors((current) => ({
        ...current,
        [harness]: models.length ? '' : 'O host não retornou modelos. Verifique instalação e autenticação.',
      }));
    } catch (error) {
      catalogRequests.current.delete(harness);
      setModelsByHarness((current) => ({ ...current, [harness]: [] }));
      setCatalogErrors((current) => ({
        ...current,
        [harness]: error instanceof Error ? error.message : 'Falha ao consultar os modelos deste host.',
      }));
    } finally {
      setCatalogLoading((current) => ({ ...current, [harness]: false }));
    }
  }, [activeProjectId, apiFetch]);

  useEffect(() => {
    catalogRequests.current.clear();
    setModelsByHarness({});
    setCatalogErrors({});
    setCatalogLoading({});
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) return;
    const hosts = new Set<string>();
    if (projectSettingsId && setupHostHarness) hosts.add(setupHostHarness);
    if (projectSettingsId) {
      for (const selection of Object.values(roleSelections)) {
        if (selection.harness) hosts.add(selection.harness);
      }
    }
    if (settingsOpen && settingsTab === 'gantry' && globalHost) hosts.add(globalHost);
    if (settingsOpen && settingsTab === 'gantry') {
      for (const selection of Object.values(globalRoles)) {
        if (selection.harness) hosts.add(selection.harness);
      }
    }
    for (const host of hosts) void ensureModelCatalog(host);
  }, [settingsOpen, settingsTab, projectSettingsId, activeProjectId, setupHostHarness, roleSelections, globalHost, globalRoles, ensureModelCatalog]);

  const loadArtifactAsset = useCallback(async (path: string, signal: AbortSignal): Promise<Blob> => {
    if (!artifactDrawer) throw new Error('Nenhum arquivo selecionado.');
    const response = await apiFetch(`/api/projects/${artifactDrawer.projectId}/artifact-assets?path=${encodeURIComponent(path)}`, { signal });
    return response.blob();
  }, [apiFetch, artifactDrawer?.projectId]);

  const loadWorkspaceState = async (): Promise<void> => {
    const generation = ++workspaceGeneration.current;
    if (workspaceLoading.current) {
      workspaceReloadRequested.current = true;
      return;
    }
    workspaceLoading.current = true;
    try {
      const res = await apiFetch('/api/workspace/state');
      if (generation !== workspaceGeneration.current) return;
      if (res.status === 401) {
        setRequiresRemotePairing(true);
        return;
      }
      if (!res.ok) return;
      setRequiresRemotePairing(false);
      const data = await res.json();
      if (generation !== workspaceGeneration.current) return;
      if (data.terminalEnvironment) setTerminalEnvironment(data.terminalEnvironment);
      if (!globalExecutionLoaded.current && data.globalExecution) {
        const execution = data.globalExecution as ExecutionSettings;
        setGlobalHost(execution.hostHarness ?? '');
        setGlobalRoles(execution.roles ?? {});
        globalExecutionLoaded.current = true;
      }
      if (!terminalSettingsLoaded.current && data.terminalSettings) {
        setTerminalSettings(data.terminalSettings);
        setTerminalDraft(data.terminalSettings);
        terminalSettingsLoaded.current = true;
      }
      const projs: RegisteredProject[] = data.projects ?? [];
      setProjects(projs);
      const actProj = data.layout?.activeProjectId ?? projs[0]?.id ?? null;
      setActiveProjectId(actProj);
      const loadedSessions = data.sessions ?? [];
      setSessions(loadedSessions);
      const requestedSessionId = data.layout?.activeSessionId;
      const actSess = loadedSessions.some((session: any) => session.id === requestedSessionId)
        ? requestedSessionId
        : loadedSessions[0]?.id ?? null;
      setActiveSessionId(actSess);
      setMessages((data.messages ?? []).filter((message: ChatMessageRecord) => message.projectId === actProj));

      const alertRes = await apiFetch('/api/alerts');
      if (alertRes.ok) {
        const alertData = await alertRes.json();
        setAlerts(alertData.alerts ?? []);
      }

      if (generation !== workspaceGeneration.current) return;
      if (actProj) {
        const paneResponse = await apiFetch(`/api/projects/${actProj}/panes`);
        const available: ManagedPane[] = (await paneResponse.json()).panes ?? [];
        setPanes(available);
        const inspRes = await apiFetch(`/api/projects/${actProj}/inspect`);
        if (inspRes.ok) {
          const projectInspection = await inspRes.json();
          setInspection(projectInspection);
          if (setupProjectLoaded.current !== actProj) {
            setSetupHostHarness(projectInspection.operatorProfile?.hostHarness ?? projectInspection.policy?.execution?.hostHarness ?? '');
            setRoleSelections({ ...projectInspection.policy?.execution?.roles, ...projectInspection.operatorProfile?.roles });
            setupProjectLoaded.current = actProj;
          }
        }
        const kbRes = await apiFetch(`/api/projects/${actProj}/kanban`);
        if (kbRes.ok) {
          const kbData = await kbRes.json();
          setKanbanRuns(kbData.runs ?? []);
        }
      } else {
        setPanes([]);
        setInspection(null);
        setKanbanRuns([]);
      }
    } catch (error) {
      reportError(error);
    } finally {
      workspaceLoading.current = false;
      if (workspaceReloadRequested.current) {
        workspaceReloadRequested.current = false;
        void loadWorkspaceState();
      }
    }
  };

  useEffect(() => {
    if (!activeProjectId) {
      setBoard(null);
      return;
    }
    const projectId = activeProjectId;
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch(`/api/projects/${projectId}/board`, { cache: 'no-store' });
        const payload = response.ok ? await response.json() : null;
        if (!cancelled) setBoard(response.ok ? coerceBoard(payload) : unavailableBoard());
      } catch {
        if (!cancelled) setBoard(unavailableBoard());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, apiFetch, boardGeneration]);

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
            if (payload.projectId === selectedPane.current.projectId && payload.paneId === selectedPane.current.paneId) {
              setTerminalBuffer((prev) => `${prev}${payload.chunk}`);
            }
          } else if (payload.type !== 'pane.input' && payload.type !== 'pane.mode_toggled') {
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
    let observer: ResizeObserver | undefined;
    void (async () => {
      try {
        const xtermMod = await import('@xterm/xterm');
        const { FitAddon } = await import('@xterm/addon-fit');
        if (disposed || !terminalContainerRef.current) return;
        const term = new xtermMod.Terminal({ cursorBlink: true, fontSize: terminalAppearance.current.fontSize, fontFamily: terminalAppearance.current.fontFamily, theme: { background: '#171715', foreground: '#edede8', cursor: '#e6ad52' } });
        const fit = new FitAddon();
        fitAddonRef.current = fit;
        term.loadAddon(fit);
        term.open(terminalContainerRef.current);
        const syncSize = () => {
          const pane = selectedPane.current;
          if (pane.projectId && pane.paneId && term.cols > 1 && term.rows > 0) void apiFetch(`/api/projects/${pane.projectId}/panes/${pane.paneId}/resize`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cols: term.cols, rows: term.rows }),
          }).catch((error) => { if (selectedPane.current.paneId === pane.paneId) reportError(error); });
        };
        term.onResize(syncSize);
        terminalRef.current = term;
        term.write(terminalBuffer);
        terminalWrittenLength.current = terminalBuffer.length;
        fit.fit();
        syncSize();
        term.onData((data) => {
          const pane = selectedPane.current;
          if (pane.projectId && pane.paneId) {
            void apiFetch(`/api/projects/${pane.projectId}/panes/${pane.paneId}/input`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
            }).catch((error) => { if (selectedPane.current.paneId === pane.paneId) reportError(error); });
          }
        });
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => fit.fit());
          observer.observe(terminalContainerRef.current);
        }
        term.focus();
      } catch (error) {
        reportError(error);
      }
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [paneMode, activePaneId, activeView]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = terminalSettings.fontFamily;
    terminal.options.fontSize = terminalSettings.fontSize;
    fitAddonRef.current?.fit();
  }, [terminalSettings.fontFamily, terminalSettings.fontSize]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.write(terminalBuffer.slice(terminalWrittenLength.current));
    terminalWrittenLength.current = terminalBuffer.length;
  }, [terminalBuffer]);

  useEffect(() => { chatEndRef.current?.scrollIntoView?.({ block: 'end' }); }, [messages.length, activeSessionId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') { setSidebarOpen(false); setProjectDialogOpen(false); }
      if ((event.metaKey || event.ctrlKey) && event.key === 'b') { event.preventDefault(); setSidebarOpen((value) => !value); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (projectDialogOpen) document.getElementById('new-project-path')?.focus();
  }, [projectDialogOpen]);
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(min-width: 760px)');
    const onChange = (event: MediaQueryListEvent) => { setSidebarOpen(event.matches); setWideWorkspace(event.matches); };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const handleChooseDirectory = withFeedback('Escolher pasta', async () => {
    const directory = await window.gantryDesktop?.chooseDirectory();
    if (directory) { setNewProjectPath(directory); setProjectDialogOpen(true); }
  });

  const handleNewSession = withFeedback('Nova conversa', async () => {
    if (!activeProjectId) return;
    const response = await apiFetch(`/api/projects/${activeProjectId}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: `Conversa ${sessions.length + 1}` }) });
    const { session } = await response.json();
    await apiFetch('/api/workspace/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeProjectId, activeSessionId: session.id }) });
    setPaneMode('chat'); setActiveView('factory'); setPreparedCommand(null);
    await loadWorkspaceState();
  });

  const handleSelectPane = withFeedback('Selecionar terminal', async (paneId: string) => {
    if (!activeProjectId) return;
    const response = await apiFetch(`/api/projects/${activeProjectId}/panes/${paneId}`);
    const { pane } = await response.json();
    setActivePaneId(paneId); setTerminalBuffer(pane.terminalBuffer); setPaneMode('terminal'); setActiveView('factory');
  });

  const handleClosePane = withFeedback('Encerrar terminal', async (paneId: string) => {
    if (!activeProjectId) return;
    if (paneId === activePaneId) {
      // Stop routing input/resize events before the backend removes this pane.
      selectedPane.current = { ...selectedPane.current, paneId: null };
      setActivePaneId(null); setTerminalBuffer(''); setPaneMode('terminal');
    }
    await apiFetch(`/api/projects/${activeProjectId}/panes/${paneId}`, { method: 'DELETE' });
    await loadWorkspaceState();
  });

  const handleAddProject = withFeedback("Adicionar projeto", async (): Promise<void> => {
    if (!newProjectPath.trim()) throw new Error('Informe o diretório do projeto. Você pode usar ~/src/meu-projeto.');
    const res = await apiFetch(`/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newProjectPath.trim() }),
    });
    if (res.ok) {
      const result = await res.json();
      await apiFetch('/api/workspace/state', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeProjectId: result.project.id, activeSessionId: result.defaultSessionId }),
      });
      setNewProjectPath('');
      setProjectDialogOpen(false); if (window.innerWidth < 760) setSidebarOpen(false); setActiveView('board');
      await loadWorkspaceState();
    }
  });

  const handleSelectProject = withFeedback("Selecionar projeto", async (projectId: string, sessionId?: string): Promise<void> => {
    setArtifactDrawer(null);
    setActivePaneId(null);
    setTerminalBuffer('');
    setApprovedSlug(null);
    setActiveRunId('');
    setPreparedCommand(null); if (window.innerWidth < 760) setSidebarOpen(false); setActiveView('board');
    setPaneMode('terminal');
    if (projectId !== activeProjectId) {
      setMessages([]);
      setSessions([]);
      setActiveSessionId(sessionId ?? null);
      setPendingPrompt(null);
      setCoordinatorInput('');
    }
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
  });

  const handleSelectSession = withFeedback("Selecionar sessão", async (sessionId: string): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto antes de selecionar uma sessão.');
    setActiveSessionId(sessionId);
    setPaneMode('chat'); setActiveView('factory'); setPreparedCommand(null);
    await apiFetch(`/api/workspace/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeProjectId, activeSessionId: sessionId }),
    });
    await loadWorkspaceState();
  });

  const handleOpenTerminal = withFeedback("Abrir terminal", async (): Promise<void> => {
    if (!activeProjectId) throw new Error('Adicione ou selecione um projeto antes de abrir um terminal.');
    const paneId = `pane-shell-${Date.now()}`;
    const res = await apiFetch(`/api/projects/${activeProjectId}/panes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paneId,
        launcher: 'shell',
        mode: 'terminal',
      }),
    });
    if (res.ok) {
      const data = await res.json();
      setActivePaneId(data.pane.paneId);
      setTerminalBuffer(data.pane.terminalBuffer ?? '');
      setPaneMode('terminal');
      setActiveView('factory');
      await loadWorkspaceState();
    } else {
      setPaneMode('terminal');
    }
  });

  const handleToggleChatTerminal = withFeedback("Alternar conversa e terminal", async (): Promise<void> => {
    const shellPane = panes.find((pane) => pane.paneId === activePaneId && pane.launcher === 'shell' && pane.status === 'running') ?? panes.find((pane) => pane.launcher === 'shell' && pane.status === 'running');
    if (activeProjectId && shellPane) {
      await handleSelectPane(shellPane.paneId);
      return;
    }
    await handleOpenTerminal();
  });

  const handleVirtualKey = withFeedback("Enviar tecla", async (keySeq: string): Promise<void> => {
    if (activeProjectId && activePaneId) {
      await apiFetch(`/api/projects/${activeProjectId}/panes/${activePaneId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: keySeq }),
      });
    }
  });

  const handleSendCoordinatorInput = withFeedback("Aguardando resposta do agente", async (executePrepared = false): Promise<void> => {
    if (!activeProjectId) throw new Error('Adicione ou selecione um projeto para conversar com o agente.');
    if (!coordinatorInput.trim()) throw new Error('Escreva uma mensagem ou descreva o que deseja planejar.');
    const match = coordinatorInput.trim().match(/^\/(plan|run|setup)(?:\s+(.*))?$/s);
    if (match && !executePrepared) {
      const response = await apiFetch(`/api/projects/${activeProjectId}/commands/prepare`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: match[1], request: match[2] ?? '' }),
      });
      const { prepared } = await response.json();
      if (selectedPane.current.projectId === activeProjectId && selectedPane.current.sessionId === activeSessionId) setPreparedCommand({ ...prepared, projectId: activeProjectId, sessionId: activeSessionId });
      return;
    }
    if (executePrepared && (!preparedCommand || preparedCommand.projectId !== activeProjectId || preparedCommand.sessionId !== activeSessionId)) throw new Error('Prepare o comando nesta conversa antes de executar.');
    const text = executePrepared && preparedCommand ? `/${preparedCommand.command} ${preparedCommand.argument}`.trim() : coordinatorInput.trim();
    setPreparedCommand(null);
    if (text === '/setup') { if (activeProjectId) setProjectSettingsId(activeProjectId); else openSettings('gantry'); setCoordinatorInput(''); return; }

    if (executePrepared && preparedCommand?.command === 'plan') {
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
        setCoordinatorInput('');
      }
      return;
    }

    if (executePrepared && preparedCommand?.command === 'run') {
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
        setCoordinatorInput('');
      }
      return;
    }

    setPendingPrompt(text);
    setCoordinatorInput('');
    const sessionId = sessions.some((session) => session.id === activeSessionId) ? activeSessionId : sessions[0]?.id;
    try {
      await apiFetch(`/api/projects/${activeProjectId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(sessionId ? { sessionId } : {}), prompt: text }),
      });
      await loadWorkspaceState();
      setPendingPrompt(null);
    } catch (error) {
      setPendingPrompt(null);
      setCoordinatorInput((current) => current.trim() ? current : text);
      throw error;
    }
  });

  const handleAnswerGrilling = withFeedback("Enviar decisões", async (
    card: Extract<DecisionCardPayload, { kind: 'grilling_round' }>,
  ): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
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
  });

  const handleRefineSpec = withFeedback("Revisar especificação", async (
    card: Extract<DecisionCardPayload, { kind: 'spec_blocked' }>,
  ): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
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
  });

  const handleEditDraftIssues = withFeedback("Revisar tarefas", async (
    slug: string,
    action: 'split' | 'merge' | 'reorder' | 'refine',
    targetRef?: string,
  ): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
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
  });

  const handleApprovePlan = withFeedback("Aprovar plano", async (slug: string): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
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
  });

  const handleStartRun = withFeedback("Executar plano", async (scope: string): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
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
  });

  const handleTakeoverWorktree = withFeedback("Assumir terminal", async (issueRef: string, worktreePath: string): Promise<void> => {
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
  });

  const handleResumeTakeover = withFeedback("Retomar execução", async (issueRef: string): Promise<void> => {
    if (!activeProjectId || !activeRunId) return;
    await apiFetch(`/api/projects/${activeProjectId}/runs/${activeRunId}/resume-takeover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueRef, sessionId: activeSessionId }),
    });
    await loadWorkspaceState();
  });

  const handleRecoverIssue = withFeedback("Recuperar tarefa", async (
    card: Extract<DecisionCardPayload, { kind: 'issue_recovery' }>,
  ): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
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
  });

  const handleDecideLesson = withFeedback("Revisar aprendizado", async (
    runId: string,
    lesson: { id: string; target: string; draftRule: string },
    decision: 'accept' | 'dismiss',
  ): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
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
  });

  const handleCreateDraftPr = withFeedback("Criar PR em rascunho", async (
    card: Extract<DecisionCardPayload, { kind: 'run_handoff' }>,
  ): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
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
  });

  const handleAuthorizeCleanup = withFeedback("Autorizar limpeza", async (
    card: Extract<DecisionCardPayload, { kind: 'run_handoff' }>,
  ): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
    await apiFetch(`/api/projects/${activeProjectId}/runs/${card.runId}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawPlanJson: card.cleanupPlan.rawPlanJson }),
    });
    await loadWorkspaceState();
  });

  const loadProjectTree = useCallback(async (relativePath: string, query: string): Promise<FileTreeEntry[]> => {
    if (!activeProjectId) return [];
    const params = new URLSearchParams();
    if (query.trim()) params.set('query', query.trim());
    else params.set('path', relativePath);
    const response = await apiFetch(`/api/projects/${activeProjectId}/tree?${params}`);
    const listing = await response.json() as { entries?: FileTreeEntry[] };
    return listing.entries ?? [];
  }, [apiFetch, activeProjectId]);

  const loadArtifact = async (relPath: string): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
    const res = await apiFetch(
      `/api/projects/${activeProjectId}/artifacts?path=${encodeURIComponent(relPath)}&diff=true`,
    );
    if (res.ok) {
      const artifact = await res.json();
      if (selectedPane.current.projectId === activeProjectId) setArtifactDrawer({ ...artifact, projectId: activeProjectId });
    }
  };
  const handleOpenArtifact = withFeedback("Abrir arquivo", loadArtifact);

  const handleFollowAgent = (ref: string, runId?: string): void => {
    const pane = panes.find((item) => item.status === 'running' && (item.activeRunId === runId || item.worktreePath.includes(ref.split('#')[0] ?? ref)));
    setActiveView('factory');
    if (pane) {
      setPaneMode('terminal');
      setActivePaneId(pane.paneId);
      return;
    }
    setPaneMode('chat');
  };

  const handleSaveArtifact = async (content: string): Promise<void> => {
    if (!artifactDrawer) return;
    const { projectId, path } = artifactDrawer;
    await apiFetch(`/api/projects/${projectId}/artifacts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    const refreshed = await apiFetch(`/api/projects/${projectId}/artifacts?path=${encodeURIComponent(path)}&diff=true`);
    const artifact = await refreshed.json();
    setArtifactDrawer((current) => current?.projectId === projectId && current.path === path ? { ...artifact, projectId } : current);
  };

  const handleSteer = withFeedback("Orientar agente", async (mode: 'queue' | 'send_now'): Promise<void> => {
    if (!activeProjectId || !activeRunId) throw new Error('Inicie ou selecione uma execução para orientar um agente.');
    if (!steeringInput.trim()) throw new Error('Escreva a orientação para o agente.');
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
  });

  const buildProposedPolicy = (): Record<string, unknown> => {
    if (!setupHostHarness) throw new Error('Selecione o host do projeto antes de salvar a configuração.');
    const policy = inspection?.policy ?? {};
    return { ...policy, execution: { ...policy.execution, hostHarness: setupHostHarness, roles: roleSelections } };
  };

  const handlePreviewSetup = withFeedback("Prévia da configuração", async (): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
    const res = await apiFetch(`/api/projects/${activeProjectId}/setup/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy: buildProposedPolicy() }),
    });
    if (res.ok) {
      const data = await res.json();
      setSetupDiffPreview(data.diff ?? '');
    }
  });

  const handleApplySetup = withFeedback("Salvar configuração do projeto", async (scope: 'repository' | 'personal'): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
    for (const [role, selection] of Object.entries(roleSelections)) {
      const harness = discoveryHarness(selection.harness);
      const catalog = modelsByHarness[harness];
      if (!catalog) throw new Error(`A lista de modelos de ${selection.harness || 'o host'} ainda não carregou para o papel ${role}.`);
      if (!catalog.some((model) => model.id === selection.model)) {
        throw new Error(`O modelo do papel ${role} não está disponível em ${selection.harness}. Escolha um modelo desse host.`);
      }
    }
    const policy = buildProposedPolicy();
    await apiFetch(`/api/projects/${activeProjectId}/setup/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope,
        policy,
        hostHarness: setupHostHarness,
        roles: (policy.execution as { roles?: Record<string, unknown> }).roles ?? {},
      }),
    });
    setupProjectLoaded.current = null;
    await loadWorkspaceState();
  });

  const handleSaveGlobalExecution = withFeedback('Salvar Gantry global', async () => {
    const response = await apiFetch('/api/settings/execution', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostHarness: globalHost, roles: globalRoles }),
    });
    const data = await response.json() as { execution: ExecutionSettings };
    setGlobalHost(data.execution.hostHarness ?? '');
    setGlobalRoles(data.execution.roles ?? {});
    globalExecutionLoaded.current = true;
  });

  const handleBootstrap = withFeedback('Instalar skills do Gantry', async () => {
    if (!activeProjectId) throw new Error('Selecione um projeto primeiro.');
    await apiFetch(`/api/projects/${activeProjectId}/bootstrap`, { method: 'POST' });
    await loadWorkspaceState();
  });

  const handleSaveTerminalSettings = withFeedback('Salvar terminal', async () => {
    const response = await apiFetch('/api/settings/terminal', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(terminalDraft),
    });
    const data = await response.json();
    setTerminalSettings(data.settings);
    setTerminalDraft(data.settings);
    setTerminalEnvironment(data.environment);
  });

  const handleGeneratePairing = withFeedback('Gerar código de acesso', async () => {
    const response = await apiFetch('/api/auth/pair/generate', { method: 'POST' });
    setPairingCode((await response.json()).code);
  });

  const handleTerminalCommand = withFeedback('Enviar comando ao terminal', async () => {
    if (!activeProjectId || !activePaneId) throw new Error('Abra um terminal antes de enviar comandos.');
    if (!terminalInput.trim()) return;
    await apiFetch(`/api/projects/${activeProjectId}/panes/${activePaneId}/input`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: `${terminalInput}\r` }),
    });
    setTerminalInput('');
  });

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

  const specInteractions: Record<string, React.ReactNode> = {};
  const issueInteractions: Record<string, React.ReactNode> = {};
  for (const message of messages) {
    const card = message.decisionCard;
    if (!card || card.resolved) continue;
    if (card.kind === 'issue_recovery') {
      issueInteractions[card.issueRef] = renderDecisionCard(card);
      continue;
    }
    if (card.kind === 'grilling_round' || card.kind === 'spec_blocked' || card.kind === 'plan_approval') {
      specInteractions[card.slug] = renderDecisionCard(card);
    }
  }

  const handleVerifyPairingCode = withFeedback("Conectar dispositivo", async (): Promise<void> => {
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
  });

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
        {feedback?.kind === 'error' && <p role="alert">{feedback.message}</p>}
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

  const activeProject = projects.find((project) => project.id === activeProjectId);
  const projectMessages = messages.filter((message) => message.projectId === activeProjectId);
  const activeTerminal = panes.find((pane) => pane.paneId === activePaneId);
  const inlineArtifact = activeView === 'files' && wideWorkspace && artifactDrawer?.projectId === activeProjectId ? artifactDrawer : null;
  const changeView = (view: typeof activeView) => { setActiveView(view); if (window.innerWidth < 760) setSidebarOpen(false); };
  const commandBusy = pendingActions.includes('Aguardando resposta do agente');
  const selectShortcut = (command: string) => {
    setPreparedCommand(null); setPaneMode('chat'); setActiveView('factory');
    setCoordinatorInput(`/${command} `);
    document.getElementById('coordinator-message')?.focus();
  };

  /* THESIS: One workspace for Gantry coordination and explicitly separate CLI terminals.
   * OWN-WORLD: The supplied herdr recording: warm charcoal, quiet borders, amber selection, system type.
   * STORY: Choose a project, converse or prepare a Gantry command, then review and execute.
   * FIRST VIEWPORT: Compact project sidebar, context header, session tabs, expansive work area and bottom composer.
   * FORM: User-pinned developer workspace; navigation becomes a drawer on narrow windows. */
  return (
    <div className={`harness-shell ${sidebarOpen ? 'navigation-open' : ''}`}>
      {sidebarOpen && <button className="navigation-scrim" aria-label="Fechar navegação" onClick={() => setSidebarOpen(false)} />}
      <aside className="sidebar" data-testid="sidebar" aria-label="Projetos e navegação">
        <div className="brand-header">
          <span className="brand-mark"><span className="brand-symbol">g</span> Gantry <span className="brand-subtitle">Harness</span></span>
          <button className="icon-button mobile-close" aria-label="Fechar menu" onClick={() => setSidebarOpen(false)}>×</button>
        </div>
        <div className="sidebar-heading"><span>Projetos</span><button className="icon-button" aria-label="Adicionar projeto" data-testid="new-project-btn" onClick={() => setProjectDialogOpen(true)}>+</button></div>
        <div className="project-list">
          {projects.length === 0 && <p className="sidebar-empty">Abra uma pasta para começar a trabalhar.</p>}
          {projects.map((project) => <div key={project.id} className={`project-row ${project.id === activeProjectId ? 'selected' : ''}`}>
            <button className="project-row-select" onClick={() => void handleSelectProject(project.id)} aria-current={project.id === activeProjectId ? 'page' : undefined}>
              <span className="folder-icon" aria-hidden="true">▱</span>
              <span className="project-row-text"><strong>{project.name}</strong><small title={project.path}>{project.path}</small></span>
              <span title={STATUS_LABELS[project.badgeState]} className={`status-dot ${project.badgeState?.replace(/\s+/g, '-')}`} />
            </button>
            <button className="icon-button project-settings" aria-label={`Configurações de ${project.name}`} data-testid={`project-settings-${project.id}`} onClick={() => { setProjectSettingsId(project.id); if (project.id !== activeProjectId) void handleSelectProject(project.id); }}>⚙</button>
            {project.id === activeProjectId && inspection && inspection.worktrees.length > 0 && <details className="project-context">
              <summary>Worktrees</summary>
              {inspection.worktrees.map((wt) => <div key={wt.path} className="worktree-row"><span title={wt.path}>{wt.branch} · {STATUS_LABELS[wt.badgeState]}</span>{wt.issueRef && <button onClick={() => void handleTakeoverWorktree(wt.issueRef!, wt.path)}>Assumir</button>}</div>)}
            </details>}
          </div>)}
        </div>
        <button className="new-project-link" onClick={() => setProjectDialogOpen(true)}>+ Abrir projeto</button>
        <div className="sidebar-bottom">
          <div className="sidebar-heading">Workspace</div>
          <button className={`btn-nav ${activeView === 'board' ? 'btn-nav-active' : ''}`} data-testid="open-board-btn" onClick={() => changeView('board')}><span>Quadro</span>{alerts.length > 0 && <span className="count-badge">{alerts.length}</span>}</button>
          <button className={`btn-nav ${activeView === 'factory' ? 'btn-nav-active' : ''}`} data-testid="open-factory-btn" onClick={() => { setPaneMode('terminal'); changeView('factory'); }}><span>Terminal</span><kbd>⌘ B</kbd></button>
          <div className="sidebar-divider" />
          <button className="btn-nav" data-testid="open-settings-btn" onClick={() => openSettings('terminal')}>Configurações</button>
          <div className="local-caption">Armazenamento local · v0.1.0</div>
        </div>
      </aside>

      <main className="main-area">
        <header className="workspace-header">
          <button className="icon-button navigation-toggle" aria-label="Alternar navegação" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((value) => !value)}>☰</button>
          <div className="workspace-title"><strong>{activeProject?.name ?? 'Gantry Harness'}</strong><span title={activeProject?.path}>{activeView === 'board' ? 'Issues e Specs' : activeProject?.path ?? 'Seu workspace de desenvolvimento'}</span></div>
          <div className="view-selector" aria-label="Área de trabalho">
            <button aria-pressed={activeView === 'board'} onClick={() => setActiveView('board')}>Quadro</button>
            <button data-testid="chat-terminal-toggle" aria-pressed={activeView === 'factory'} disabled={!activeProjectId || pendingActions.includes('Abrir terminal')} onClick={() => { setPaneMode('terminal'); setActiveView('factory'); if (activeTerminal?.launcher !== 'shell' || activeTerminal?.status !== 'running') void handleToggleChatTerminal(); }}>Terminal</button>
            <button data-testid="open-files-btn" aria-pressed={activeView === 'files'} onClick={() => setActiveView('files')}>Files</button>
          </div>
        </header>

        <div className="workspace-context">
          <button className="context-help" onClick={() => setShowGuide((value) => !value)} aria-expanded={showGuide}>Ajuda</button>
        </div>
        {showGuide && <section className="workspace-guide"><strong>Do projeto à execução</strong><p>Abra uma pasta e use o terminal para executar comandos ou restaurar sessões do Codex, Claude e OpenCode. O quadro mostra as Issues e Specs do repositório.</p><button onClick={() => setShowGuide(false)}>Entendi</button></section>}
        {pendingActions.length > 0 && <div className="action-pending" role="status" aria-live="polite"><span className="working-indicator" />{pendingActions.join(' · ')}…</div>}
        {feedback?.kind === 'error' && !projectDialogOpen && !settingsOpen && !projectSettingsId && <div className="action-feedback error" role="alert"><p>{feedback.message}</p><div className="feedback-actions"><button onClick={() => openSettings('terminal')}>Revisar configuração</button><button aria-label="Fechar aviso" onClick={dismissFeedback}>×</button></div></div>}
        {board?.explanation === NO_PACK_EXPLANATION && activeProjectId && <div className="action-feedback error" role="alert" data-testid="pack-missing"><p>{board.explanation}</p><div className="feedback-actions"><button onClick={() => setProjectSettingsId(activeProjectId)}>Configurar este projeto</button><button onClick={() => openSettings('gantry')}>Configuração global</button></div></div>}
        {alerts.length > 0 && <button className="alert-banner" data-testid="alert-banner" onClick={() => { const first = alerts[0]; void handleSelectProject(first.projectId, first.sessionId); setActiveView('factory'); }}><span>{alerts[0].projectName} · {alerts[0].summary || STATUS_LABELS[alerts[0].badgeState]}</span><span>Revisar decisão →</span></button>}

        {activeView === 'board' && (
          <BoardView
            board={board}
            hasProject={Boolean(activeProjectId)}
            overlays={overlaysFromKanban(kanbanRuns)}
            specInteractions={specInteractions}
            issueInteractions={issueInteractions}
            onRefresh={() => setBoardGeneration((value) => value + 1)}
            onOpenPath={(path) => void handleOpenArtifact(path)}
            onFollow={handleFollowAgent}
          />
        )}

        {activeView === 'factory' && <div className="workspace-content">
          <div className="session-bar">
            <div className="session-tabs" aria-label="Terminais">
              {panes.map((pane) => <div key={pane.paneId} className={`terminal-tab ${pane.paneId === activePaneId ? 'active' : ''}`}><button onClick={() => void handleSelectPane(pane.paneId)}><span className={`status-dot ${pane.status === 'running' ? 'done' : 'idle'}`} />{pane.launcher}<small>{pane.status === 'exited' ? `Encerrado (${pane.exitCode ?? '—'})` : 'Em execução'}</small></button><button className="tab-close" aria-label={`Encerrar terminal ${pane.launcher}`} onClick={() => void handleClosePane(pane.paneId)}>×</button></div>)}
            </div>
            <button className="new-terminal-button" data-testid="launcher-shell" disabled={!activeProjectId || pendingActions.includes('Abrir terminal')} onClick={() => void handleOpenTerminal()}>+ Terminal</button>
          </div>
          {activeProject?.lifecycleState && activeProject.lifecycleState !== 'idle' && <div className="run-strip"><span className={`status-dot ${activeProject.badgeState?.replace(/\s+/g, '-')}`} /><strong>{PHASE_LABELS[activeProject.lifecycleState] ?? activeProject.lifecycleState}</strong>{activeRunId && <code>{activeRunId}</code>}<button onClick={() => setActiveView('board')}>Ver quadro →</button></div>}
          {approvedSlug && <div className="run-strip"><span>Plano aprovado: <strong>{approvedSlug}</strong></span><button className="btn-primary" data-testid="start-run-btn" disabled={pendingActions.includes('Executar plano')} onClick={() => void handleStartRun(approvedSlug)}>Executar plano</button></div>}

          <div className="terminal-workspace" data-testid="terminal-view">
            {activePaneId ? <><div className="terminal-caption"><span>{activeTerminal?.launcher ?? 'Terminal'} · {activeTerminal?.status === 'exited' ? 'Sessão encerrada' : activeTerminal?.launcher === 'shell' ? 'Shell do sistema' : 'Sessão CLI independente'}</span><code>{activeTerminal?.worktreePath ?? activeProject?.path}</code></div><div className="terminal-surface"><div ref={terminalContainerRef} className="terminal-emulator" aria-label="Terminal interativo" /></div><details className="terminal-tools"><summary>Teclas e envio de comando</summary><form className="terminal-command" onSubmit={(event) => { event.preventDefault(); void handleTerminalCommand(); }}><label htmlFor="terminal-command">Enviar ao terminal</label><input id="terminal-command" value={terminalInput} onChange={(event) => setTerminalInput(event.target.value)} placeholder="Mensagem ou comando para este terminal" /><button type="submit" disabled={!activePaneId}>Enviar</button></form><div className="virtual-keybar" data-testid="virtual-keybar">{[['esc', '\x1b'], ['tab', '\t'], ['^C', '\x03'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C']].map(([label, key]) => <button key={label} className="btn-key" onClick={() => void handleVirtualKey(key)}>{label}</button>)}</div></details></> : <div className="chat-empty"><h1>Abra uma sessão de terminal</h1><p>Abra o shell do sistema para executar comandos ou restaurar sessões do Codex, Claude e OpenCode com os parâmetros que preferir.</p><button onClick={() => void handleOpenTerminal()}>Abrir shell</button></div>}
          </div>
          {activeRunId && <details className="steering-panel"><summary>Orientar agente em execução · {activeRunId}</summary><div data-testid="steering-bar"><input aria-label="Tarefa a orientar" placeholder="Referência da tarefa" value={selectedSteeringIssue} onChange={(event) => setSelectedSteeringIssue(event.target.value)} /><input aria-label="Orientação para o agente" placeholder="Descreva sua orientação…" value={steeringInput} onChange={(event) => setSteeringInput(event.target.value)} /><button data-testid="steer-queue-btn" onClick={() => void handleSteer('queue')}>Próximo turno</button><button data-testid="steer-send-now-btn" onClick={() => void handleSteer('send_now')}>Enviar agora</button></div></details>}
        </div>}

        {activeView === 'files' && (
          <div className={`file-workspace${wideWorkspace && activeProjectId ? ' split' : ''}`} data-testid="files-workspace">
            <FileTree key={activeProjectId ?? 'none'} projectId={activeProjectId} projectName={activeProject?.name ?? 'Projeto'} loadEntries={loadProjectTree} selectedPath={artifactDrawer?.projectId === activeProjectId ? artifactDrawer.path : null} onOpenFile={(filePath) => void handleOpenArtifact(filePath)} onOpenProject={() => setProjectDialogOpen(true)} />
            {wideWorkspace && activeProjectId && (inlineArtifact
              ? <FileViewerDialog key={`${inlineArtifact.projectId}:${inlineArtifact.path}`} presentation="pane" artifact={inlineArtifact} onClose={() => setArtifactDrawer(null)} onSave={handleSaveArtifact} onOpenFile={loadArtifact} onLoadAsset={loadArtifactAsset} />
              : <section className="file-viewer-placeholder" data-testid="file-viewer-placeholder"><p>Selecione um arquivo para ver o conteúdo.</p></section>)}
          </div>
        )}

        {settingsOpen && <SettingsDialog tab={settingsTab} onTabChange={setSettingsTab} onClose={() => setSettingsOpen(false)}>
          {pendingActions.length > 0 && <p className="settings-notice" role="status">{pendingActions.join(' · ')}…</p>}
          {feedback && !pendingActions.length && <p className={`settings-notice ${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}</p>}
          {settingsTab === 'terminal' && <section className="settings-panel">
            <h2>Terminal</h2>
            <p>Escolha a aparência e o shell para seus comandos. O terminal inicia no diretório do projeto.</p>
            <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void handleSaveTerminalSettings(); }}>
              <SystemFontSelect value={terminalDraft.fontFamily} onChange={(fontFamily) => setTerminalDraft((current) => ({ ...current, fontFamily }))} />
              <label htmlFor="terminal-font-size">Tamanho da fonte (px)</label>
              <input id="terminal-font-size" type="number" min={8} max={40} step={1} required value={terminalDraft.fontSize} onChange={(event) => setTerminalDraft((current) => ({ ...current, fontSize: Number(event.target.value) }))} />
              <label htmlFor="terminal-shell">Shell do terminal</label>
              <select id="terminal-shell" disabled={!terminalEnvironment} value={terminalDraft.shell} onChange={(event) => setTerminalDraft((current) => ({ ...current, shell: event.target.value as TerminalSettings['shell'] }))}>
                {(terminalEnvironment?.shells ?? [{ id: 'system', label: 'Padrão do sistema', available: true }]).map((shell) => <option key={shell.id} value={shell.id} disabled={!shell.available}>{shell.label}{shell.available ? '' : ' (indisponível)'}</option>)}
              </select>
              <p className="field-help">{terminalEnvironment ? `Sistema: ${terminalEnvironment.platformLabel}. ` : 'Carregando sistema… '}A troca de shell se aplica a novos terminais. As sessões abertas continuam em execução.</p>
              <pre className="terminal-font-preview" aria-label="Prévia da fonte" style={{ fontFamily: terminalDraft.fontFamily, fontSize: terminalDraft.fontSize }}>{'$ gantry --help\n0123456789  Aa Bb Cc  → ~ /'}</pre>
              <button className="btn-primary" type="submit" disabled={!terminalEnvironment || pendingActions.includes('Salvar terminal')}>{pendingActions.includes('Salvar terminal') ? 'Salvando…' : 'Salvar terminal'}</button>
            </form>
          </section>}
        {settingsTab === 'gantry' && <section className="settings-panel" data-testid="global-gantry-panel">
            <h2>Gantry global</h2>
            <p className="section-intro">Opcional. O processo usa esta configuração quando o projeto não tem a própria. A configuração do projeto tem prioridade.</p>
            <label htmlFor="global-host">Host global</label>
            <select id="global-host" value={globalHost} onChange={(event) => setGlobalHost(event.target.value)}>
              <option value="">Sem host global</option>
              {EXECUTION_HOSTS.map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}
            </select>
            <div className="role-settings">
              <h3>Papéis globais</h3>
              {Object.entries(globalRoles).map(([role, selection]) => {
                const harness = discoveryHarness(selection.harness);
                const hostLabel = EXECUTION_HOSTS.find((host) => host.id === selection.harness)?.label ?? selection.harness;
                return <div key={role} className="role-setting-row">
                  <strong>{role}</strong>
                  <label>Host<select aria-label={`Host global para ${role}`} value={selection.harness} onChange={(event) => {
                    const nextHarness = event.target.value;
                    setGlobalRoles((current) => ({ ...current, [role]: { ...selection, harness: nextHarness, model: '' } }));
                    void ensureModelCatalog(nextHarness);
                  }}>
                    {EXECUTION_HOSTS.map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}
                  </select></label>
                  <ModelSelect
                    label="Modelo"
                    ariaLabel={`Modelo global para ${role}`}
                    harnessLabel={hostLabel}
                    models={modelsByHarness[harness] ?? []}
                    value={selection.model}
                    loading={catalogLoading[harness] === true}
                    error={catalogErrors[harness]}
                    onChange={(modelId) => setGlobalRoles((current) => ({ ...current, [role]: { ...selection, model: modelId } }))}
                  />
                </div>;
              })}
              {Object.keys(globalRoles).length === 0 && <button disabled={!globalHost} onClick={() => setGlobalRoles(Object.fromEntries(['plan', 'implement', 'review', 'critic'].map((role) => [role, { harness: globalHost, model: '' }])))}>Configurar papéis globais</button>}
            </div>
            <button className="btn-primary" data-testid="save-global-execution" disabled={pendingActions.includes('Salvar Gantry global')} onClick={() => void handleSaveGlobalExecution()}>{pendingActions.includes('Salvar Gantry global') ? 'Salvando…' : 'Salvar Gantry global'}</button>
          </section>}
          {settingsTab === 'remote' && (<section className="settings-panel remote-settings"><h2>Acesso remoto por código</h2>
              <p>Gere um código para conectar outro dispositivo pela sua rede ou Tailscale.</p>
              <button disabled={pendingActions.includes('Gerar código de acesso')} onClick={() => void handleGeneratePairing()}>Gerar código de acesso</button>
              {pairingCode && <div data-testid="pairing-code-display">Código: {pairingCode}</div>}
            </section>)}
        </SettingsDialog>}

        {projectSettingsId && <div className="dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) setProjectSettingsId(null); }}>
          <section className="project-dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="project-settings-title">
            <div className="dialog-heading"><h2 id="project-settings-title">Configurações de {projects.find((project) => project.id === projectSettingsId)?.name ?? 'projeto'}</h2><button aria-label="Fechar configurações do projeto" onClick={() => setProjectSettingsId(null)}>×</button></div>
            {activeProjectId === projectSettingsId ? (
<div data-testid="setup-panel" style={{ padding: 16, overflowY: 'auto' }}>
            <h2>Preparar o projeto para execução</h2>
            <p className="section-intro">Cada papel usa um host e só pode receber um modelo desse host. A lista é lida do agente instalado. Esta configuração tem prioridade sobre a global.</p>
            {inspection?.remediationCards.map((card) => <div key={card.kind} className="setup-diagnostic"><strong>{card.title}</strong><p>{card.description}</p><p>{card.remediation}</p></div>)}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                data-testid="bootstrap-skills-btn"
                disabled={!activeProjectId || pendingActions.includes('Instalar skills do Gantry')}
                onClick={() => void handleBootstrap()}
              >
                Instalar / atualizar skills do Gantry
              </button>
            </div>
            <div>
              <label>
                Host do projeto:{' '}
                <select
                  value={setupHostHarness}
                  onChange={(e) => setSetupHostHarness(e.target.value)}
                >
                  <option value="">Selecione o host</option>
                  {EXECUTION_HOSTS.map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}
                </select>
              </label>
            </div>
            <div className="role-settings">
              <h3>Modelos por papel</h3>
              <p>O modelo de cada papel vem do host escolhido nessa linha. Trocar o host limpa um modelo que não pertence a ele.</p>
              {Object.entries(roleSelections).map(([role, selection]) => {
                const harness = discoveryHarness(selection.harness);
                const hostLabel = EXECUTION_HOSTS.find((host) => host.id === selection.harness)?.label ?? selection.harness;
                return <div key={role} className="role-setting-row">
                  <strong>{role}</strong>
                  <label>Host<select aria-label={`Host para ${role}`} value={selection.harness} onChange={(event) => {
                    const nextHarness = event.target.value;
                    setRoleSelections((current) => ({ ...current, [role]: { ...selection, harness: nextHarness, model: '' } }));
                    void ensureModelCatalog(nextHarness);
                  }}>
                    {EXECUTION_HOSTS.map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}
                    {selection.harness && !EXECUTION_HOSTS.some((host) => host.id === selection.harness) && <option value={selection.harness}>{selection.harness}</option>}
                  </select></label>
                  <ModelSelect
                    label="Modelo"
                    ariaLabel={`Modelo para ${role}`}
                    harnessLabel={hostLabel}
                    models={modelsByHarness[harness] ?? []}
                    value={selection.model}
                    loading={catalogLoading[harness] === true}
                    error={catalogErrors[harness]}
                    onChange={(modelId) => setRoleSelections((current) => ({ ...current, [role]: { ...selection, model: modelId } }))}
                  />
                  <label>Esforço<input aria-label={`Esforço para ${role}`} value={selection.effort ?? ''} onChange={(event) => setRoleSelections((current) => ({ ...current, [role]: { ...selection, effort: event.target.value } }))} /></label>
                </div>;
              })}
              {Object.keys(roleSelections).length === 0 && <button disabled={!setupHostHarness} onClick={() => setRoleSelections(Object.fromEntries(['plan', 'implement', 'review', 'critic'].map((role) => [role, { harness: setupHostHarness, model: '' }])))}>Configurar papéis de execução</button>}
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <button data-testid="preview-setup-btn" onClick={() => void handlePreviewSetup()}>
                Revisar prévia das alterações
              </button>
              <button
                data-testid="apply-repo-setup-btn"
                onClick={() => void handleApplySetup('repository')}
              >
                Salvar no repositório
              </button>
              <button
                data-testid="apply-personal-setup-btn"
                onClick={() => void handleApplySetup('personal')}
              >
                Salvar apenas no perfil pessoal
              </button>
            </div>
            {setupDiffPreview && (
              <pre data-testid="setup-diff-preview" style={{ marginTop: 12 }}>
                {setupDiffPreview}
              </pre>
            )}
          </div>
            ) : <p className="settings-empty">Carregando a configuração do projeto…</p>}
          </section>
        </div>}

        {artifactDrawer && !inlineArtifact && <FileViewerDialog key={`${artifactDrawer.projectId}:${artifactDrawer.path}`} artifact={artifactDrawer} onClose={() => setArtifactDrawer(null)} onSave={handleSaveArtifact} onOpenFile={loadArtifact} onLoadAsset={loadArtifactAsset} />}

      </main>
      {projectDialogOpen && <div className="dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) setProjectDialogOpen(false); }}><section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" onKeyDown={(event) => { if (event.key === 'Tab') { const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input')); const first = controls[0]; const last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } }}><div className="dialog-heading"><h2 id="project-dialog-title">Abrir projeto</h2><button aria-label="Fechar diálogo" onClick={() => setProjectDialogOpen(false)}>×</button></div><p>Escolha uma pasta local. As configurações do Gantry serão carregadas a partir dela.</p>{feedback?.kind === 'error' && <p role="alert" className="dialog-error">{feedback.message}</p>}<label htmlFor="new-project-path">Diretório do projeto</label><div className="directory-field"><input id="new-project-path" placeholder="/path/to/repo" value={newProjectPath} onChange={(event) => setNewProjectPath(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void handleAddProject(); }} />{window.gantryDesktop && <button onClick={() => void handleChooseDirectory()}>Escolher pasta</button>}</div><div className="dialog-actions"><button onClick={() => setProjectDialogOpen(false)}>Cancelar</button><button className="btn-primary" data-testid="add-project-btn" disabled={pendingActions.includes('Adicionar projeto')} onClick={() => void handleAddProject()}>Abrir projeto</button></div></section></div>}
    </div>
  );
}
