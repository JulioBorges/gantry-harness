import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useActionFeedback } from './useActionFeedback.js';
import { FileViewerDialog } from './FileViewerDialog.js';
import { FileTree, type FileTreeEntry } from './FileTree.js';
import type { ExecutionSettings, RoleCommand } from '../types.js';
import type { ManagedPane } from '../server/ptyManager.js';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { TerminalSettings, TerminalEnvironment } from '../types.js';
import { SettingsDialog, type SettingsTab } from './SettingsDialog.js';
import { SystemFontSelect } from './SystemFontSelect.js';
import { BoardView } from './BoardView.js';

import {
  NO_PACK_EXPLANATION,
  PHASE_LABEL,
  coerceBoard,
  unavailableBoard,
  type BoardSnapshot,
  type HarnessRunRecord,
} from '../boardModel.js';
import type {
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

export function App({ apiBaseUrl = '' }: AppProps): React.ReactElement {
  const [projects, setProjects] = useState<RegisteredProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

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
  const [paneMode, setPaneMode] = useState<'terminal'>('terminal');
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [terminalBuffer, setTerminalBuffer] = useState<string>('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [activeRunId, setActiveRunId] = useState<string>('');

  const [artifactDrawer, setArtifactDrawer] = useState<{
    projectId: string;
    path: string;
    content: string;
    diff: string;
  } | null>(null);

  const [runs, setRuns] = useState<HarnessRunRecord[]>([]);
  const [commandErrors, setCommandErrors] = useState<Record<string, string>>({});

  const [projectSettingsId, setProjectSettingsId] = useState<string | null>(null);
  const [globalRoles, setGlobalRoles] = useState<Record<string, RoleCommand>>({});
  const globalExecutionLoaded = useRef(false);
  const [roleSelections, setRoleSelections] = useState<Record<string, RoleCommand>>({});
  const setupProjectLoaded = useRef<string | null>(null);
  const { feedback, pendingActions, withFeedback, reportError, dismissFeedback } = useActionFeedback();
  const [terminalInput, setTerminalInput] = useState('');
  const [panes, setPanes] = useState<ManagedPane[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 760);
  const [wideWorkspace, setWideWorkspace] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 760);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
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
      throw Object.assign(new Error(data.error ?? `A solicitação falhou (HTTP ${response.status}). Tente novamente.`), { code: data.code });
    }
    return response;
  }, [base, authToken]);

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
      const requestedSessionId = data.layout?.activeSessionId;
      const actSess = loadedSessions.some((session: { id: string }) => session.id === requestedSessionId)
        ? requestedSessionId
        : loadedSessions[0]?.id ?? null;
      setActiveSessionId(actSess);
      if (Array.isArray(data.runs)) {
        setRuns(data.runs as HarnessRunRecord[]);
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
            setRoleSelections(projectInspection.roleCommands ?? {});
            setupProjectLoaded.current = actProj;
          }
        }
      } else {
        setPanes([]);
        setInspection(null);
        setRuns([]);
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
        if (!cancelled) {
          setBoard(response.ok ? coerceBoard(payload) : unavailableBoard());
          if (payload && typeof payload === 'object' && Array.isArray((payload as { runs?: unknown }).runs)) {
            setRuns((payload as { runs: HarnessRunRecord[] }).runs);
          }
        }
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
          } else if (
            (payload.type === 'run.event' || payload.type === 'run.paused' || payload.type === 'run.finished') &&
            payload.run
          ) {
            if (!selectedPane.current.projectId || payload.projectId === selectedPane.current.projectId) {
              const incoming = payload.run as HarnessRunRecord;
              setRuns((current) => {
                if (incoming.status === 'rejected' || incoming.status === 'discarded') {
                  return current.filter((item) => item.ref !== incoming.ref && item.runId !== incoming.runId);
                }
                const idx = current.findIndex((item) => item.ref === incoming.ref || item.runId === incoming.runId);
                if (idx === -1) return [...current, incoming];
                const next = [...current];
                next[idx] = incoming;
                return next;
              });
              setBoardGeneration((value) => value + 1);
            }
            void loadWorkspaceState();
          } else if (payload.type === 'board.changed') {
            if (!selectedPane.current.projectId || payload.projectId === selectedPane.current.projectId) {
              setBoardGeneration((value) => value + 1);
            }
            void loadWorkspaceState();
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
    setActiveRunId('');
    if (window.innerWidth < 760) setSidebarOpen(false); setActiveView('board');
    setPaneMode('terminal');
    if (projectId !== activeProjectId) {
      setActiveSessionId(sessionId ?? null);
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

  const handleVirtualKey = withFeedback("Enviar tecla", async (keySeq: string): Promise<void> => {
    if (activeProjectId && activePaneId) {
      await apiFetch(`/api/projects/${activeProjectId}/panes/${activePaneId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: keySeq }),
      });
    }
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

  const handleRunIssue = withFeedback('Executar issue', async (ref: string): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
    const errorKey = `${activeProjectId}:${ref}`;
    let res: Response;
    try {
      res = await apiFetch(`/api/projects/${activeProjectId}/runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref }),
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'role-command-missing') {
        setCommandErrors((current) => ({ ...current, [errorKey]: error.message }));
        return;
      }
      throw error;
    }
    setCommandErrors((current) => { const next = { ...current }; delete next[errorKey]; return next; });
    if (res.ok) {
      const out = await res.json();
      const updatedRun = (out.run ?? out) as HarnessRunRecord;
      if (updatedRun?.runId) {
        setActiveRunId(updatedRun.runId);
        setRuns((current) => {
          const idx = current.findIndex((item) => item.ref === updatedRun.ref);
          if (idx === -1) return [...current, updatedRun];
          const next = [...current];
          next[idx] = updatedRun;
          return next;
        });
      }
      setBoardGeneration((value) => value + 1);
    }
  });

  const handleAnswerPause = async (ref: string, choice: string): Promise<void> => {
    if (!activeProjectId) {
      reportError(new Error('Selecione um projeto para continuar.'), 'Responder pausa');
      return;
    }
    try {
      const res = await apiFetch(`/api/projects/${activeProjectId}/runs/${encodeURIComponent(ref)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice }),
      });
      if (res.ok) {
        const out = await res.json();
        const updatedRun = (out.run ?? out) as HarnessRunRecord;
        if (updatedRun?.runId) {
          setRuns((current) => {
            if (updatedRun.status === 'rejected' || updatedRun.status === 'discarded') {
              return current.filter((item) => item.ref !== updatedRun.ref && item.runId !== updatedRun.runId);
            }
            const idx = current.findIndex((item) => item.ref === updatedRun.ref);
            if (idx === -1) return [...current, updatedRun];
            const next = [...current];
            next[idx] = updatedRun;
            return next;
          });
        }
        setBoardGeneration((value) => value + 1);
      }
    } catch (error) {
      reportError(error, 'Responder pausa');
    }
  };

  const handleStartPlanRun = withFeedback('Planejar spec', async (slug: string): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
    try {
      const res = await apiFetch(`/api/projects/${activeProjectId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, kind: 'plan' }),
      });
      if (res.ok) {
        const out = await res.json();
        const updatedRun = (out.run ?? out) as HarnessRunRecord;
        if (updatedRun?.runId) {
          setActiveRunId(updatedRun.runId);
          setRuns((current) => {
            const idx = current.findIndex((item) => item.ref === updatedRun.ref);
            if (idx === -1) return [...current, updatedRun];
            const next = [...current];
            next[idx] = updatedRun;
            return next;
          });
        }
      }
    } finally {
      setBoardGeneration((value) => value + 1);
    }
  });

  const handleExecuteWave = withFeedback('Executar onda', async (): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
    const res = await apiFetch(`/api/projects/${activeProjectId}/waves/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const out = await res.json();
      if (Array.isArray(out.runs)) {
        const waveRuns = out.runs as HarnessRunRecord[];
        if (waveRuns[0]?.runId) setActiveRunId(waveRuns[0].runId);
        setRuns((current) => {
          const next = [...current];
          for (const updatedRun of waveRuns) {
            const idx = next.findIndex((item) => item.ref === updatedRun.ref);
            if (idx === -1) next.push(updatedRun);
            else next[idx] = updatedRun;
          }
          return next;
        });
      }
      setBoardGeneration((value) => value + 1);
    }
  });

  const handleResumeRun = withFeedback('Retomar run', async (ref: string): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
    const res = await apiFetch(`/api/projects/${activeProjectId}/runs/${encodeURIComponent(ref)}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const out = await res.json();
      const updatedRun = (out.run ?? out) as HarnessRunRecord;
      if (updatedRun?.runId) {
        setActiveRunId(updatedRun.runId);
        setRuns((current) => {
          const idx = current.findIndex((item) => item.ref === updatedRun.ref);
          if (idx === -1) return [...current, updatedRun];
          const next = [...current];
          next[idx] = updatedRun;
          return next;
        });
      }
      setBoardGeneration((value) => value + 1);
    }
  });

  const handleDiscardRun = withFeedback('Descartar run', async (ref: string): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
    const res = await apiFetch(`/api/projects/${activeProjectId}/runs/${encodeURIComponent(ref)}/discard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      setRuns((current) => current.filter((item) => item.ref !== ref));
      setBoardGeneration((value) => value + 1);
    }
  });

  const handleApproveRun = withFeedback('Aprovar run', async (ref: string): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
    try {
      const res = await apiFetch(`/api/projects/${activeProjectId}/runs/${encodeURIComponent(ref)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const out = await res.json();
        const updatedRun = (out.run ?? out) as HarnessRunRecord;
        if (updatedRun?.runId) {
          setRuns((current) => {
            const idx = current.findIndex((item) => item.ref === updatedRun.ref);
            if (idx === -1) return [...current, updatedRun];
            const next = [...current];
            next[idx] = updatedRun;
            return next;
          });
        }
      }
    } finally {
      setBoardGeneration((value) => value + 1);
    }
  });

  const handleReopenPr = withFeedback('Reabrir PR', async (ref: string): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
    const res = await apiFetch(`/api/projects/${activeProjectId}/runs/${encodeURIComponent(ref)}/reopen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const out = await res.json();
      const updatedRun = (out.run ?? out) as HarnessRunRecord;
      if (updatedRun?.runId) {
        setRuns((current) => {
          const idx = current.findIndex((item) => item.ref === updatedRun.ref);
          if (idx === -1) return [...current, updatedRun];
          const next = [...current];
          next[idx] = updatedRun;
          return next;
        });
      }
      setBoardGeneration((value) => value + 1);
    }
  });

  const handleFollowAgent = (ref: string, runId?: string): void => {
    const matchedRun = runs.find((item) => (runId && item.runId === runId) || item.ref === ref);
    if (matchedRun) {
      setActiveRunId(matchedRun.runId);
    } else if (runId) {
      setActiveRunId(runId);
    }
    const pane = panes.find(
      (item) =>
        item.status === 'running' &&
        (item.activeRunId === runId ||
          (matchedRun?.worktree && item.worktreePath === matchedRun.worktree) ||
          item.worktreePath.includes(ref.split('#')[0] ?? ref)),
    );
    setActiveView('factory');
    setPaneMode('terminal');
    if (pane) setActivePaneId(pane.paneId);
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


  const handleApplySetup = withFeedback('Salvar configuração do projeto', async (): Promise<void> => {
    if (!activeProjectId) return;
    await apiFetch(`/api/projects/${activeProjectId}/commands`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roles: roleSelections }),
    });
    setupProjectLoaded.current = null;
    await loadWorkspaceState();
  });

  const handleSaveGlobalExecution = withFeedback('Salvar Gantry global', async () => {
    const response = await apiFetch('/api/settings/execution', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roles: globalRoles }),
    });
    const data = await response.json() as { execution: ExecutionSettings };
    setGlobalRoles(data.execution.roles ?? {});
    globalExecutionLoaded.current = true;
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
  const activeTerminal = panes.find((pane) => pane.paneId === activePaneId);
  const inlineArtifact = activeView === 'files' && wideWorkspace && artifactDrawer?.projectId === activeProjectId ? artifactDrawer : null;
  const changeView = (view: typeof activeView) => { setActiveView(view); if (window.innerWidth < 760) setSidebarOpen(false); };

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
            {project.id === activeProjectId && runs.some((run) => run.projectId === project.id && run.kind === 'issue' && run.worktree && run.worktree !== project.path) && <details className="project-context">
              <summary>Worktrees</summary>
              {runs.filter((run) => run.projectId === project.id && run.kind === 'issue' && run.worktree && run.worktree !== project.path).map((run) => <div key={run.runId} className="worktree-row"><strong>{run.ref}</strong><small title={run.worktree!}>{run.worktree}</small></div>)}
            </details>}
          </div>)}
        </div>
        <button className="new-project-link" onClick={() => setProjectDialogOpen(true)}>+ Abrir projeto</button>
        <div className="sidebar-bottom">
          <div className="sidebar-heading">Workspace</div>
          <button className={`btn-nav ${activeView === 'board' ? 'btn-nav-active' : ''}`} data-testid="open-board-btn" onClick={() => changeView('board')}><span>Quadro</span></button>
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
            <button data-testid="chat-terminal-toggle" aria-pressed={activeView === 'factory'} disabled={!activeProjectId} onClick={() => { setPaneMode('terminal'); setActiveView('factory'); }}>Terminal</button>
            <button data-testid="open-files-btn" aria-pressed={activeView === 'files'} onClick={() => setActiveView('files')}>Files</button>
          </div>
        </header>

        <div className="workspace-context">
          <button className="context-help" onClick={() => setShowGuide((value) => !value)} aria-expanded={showGuide}>Ajuda</button>
        </div>
        {showGuide && <section className="workspace-guide"><strong>Do projeto à execução</strong><p>Abra uma pasta e use o terminal para executar comandos ou restaurar sessões do Codex, Claude e OpenCode. O quadro mostra as Issues e Specs do repositório.</p><button onClick={() => setShowGuide(false)}>Entendi</button></section>}
        {pendingActions.length > 0 && <div className="action-pending" role="status" aria-live="polite"><span className="working-indicator" />{pendingActions.join(' · ')}…</div>}
        {feedback?.kind === 'error' && !projectDialogOpen && !settingsOpen && !projectSettingsId && <div className="action-feedback error" role="alert"><p>{feedback.message}</p><div className="feedback-actions"><button onClick={() => openSettings('terminal')}>Revisar configuração</button><button aria-label="Fechar aviso" onClick={dismissFeedback}>×</button></div></div>}
        {activeView === 'board' && board?.explanation === NO_PACK_EXPLANATION && activeProjectId && <div className="action-feedback error" role="alert" data-testid="pack-missing"><p>{board.explanation}</p><div className="feedback-actions"><button onClick={() => setProjectSettingsId(activeProjectId)}>Configurar este projeto</button><button onClick={() => openSettings('gantry')}>Configuração global</button></div></div>}
        {activeView === 'board' && (
          <BoardView
            board={board}
            hasProject={Boolean(activeProjectId)}
            runs={runs}
            onRefresh={() => setBoardGeneration((value) => value + 1)}
            onOpenPath={(path) => void handleOpenArtifact(path)}
            onFollow={handleFollowAgent}
            onRunIssue={(ref) => void handleRunIssue(ref)}
            onConfigureProject={() => setProjectSettingsId(activeProjectId)}
            issueInteractions={Object.fromEntries((board?.issues ?? []).filter((issue) => commandErrors[`${activeProjectId}:${issue.ref}`]).map((issue) => [issue.ref,
              <div role="alert" className="board-run-error" data-testid={`run-error-${issue.ref}`}>
                <p>{commandErrors[`${activeProjectId}:${issue.ref}`]}</p>
                <button onClick={() => setProjectSettingsId(activeProjectId)}>Configurar este projeto</button>
              </div>,
            ]))}
            onExecuteWave={() => void handleExecuteWave()}
            onStartPlan={(slug) => void handleStartPlanRun(slug)}
            onAnswerPause={(ref, choice) => void handleAnswerPause(ref, choice)}
            onResumeRun={(ref) => void handleResumeRun(ref)}
            onDiscardRun={(ref) => void handleDiscardRun(ref)}
            onApproveRun={(ref) => void handleApproveRun(ref)}
            onReopenPr={(ref) => void handleReopenPr(ref)}
          />
        )}

        {activeView === 'factory' && (() => {
          const followedRun =
            runs.find((item) => item.runId === activeRunId) ??
            runs.find((item) => item.status === 'running' || item.status === 'paused') ??
            null;
          return <div className="workspace-content">
          <div className="session-bar">
            <div className="session-tabs" aria-label="Terminais">
              {panes.map((pane) => <div key={pane.paneId} className={`terminal-tab ${pane.paneId === activePaneId ? 'active' : ''}`}><button onClick={() => void handleSelectPane(pane.paneId)}><span className={`status-dot ${pane.status === 'exited' ? 'done' : 'working'}`} />{pane.launcher}<small>{pane.status === 'exited' ? `Encerrado (${pane.exitCode ?? '—'})` : 'Em execução'}</small></button><button className="tab-close" aria-label={`Encerrar terminal ${pane.launcher}`} onClick={() => void handleClosePane(pane.paneId)}>×</button></div>)}
            </div>
            <button className="new-terminal-button" data-testid="launcher-shell" disabled={!activeProjectId || pendingActions.includes('Abrir terminal')} onClick={() => void handleOpenTerminal()}>+ Terminal</button>
          </div>
          {followedRun && (
            <div className="run-strip" data-testid="run-strip">
              <span className={`status-dot ${(activeProject?.badgeState ?? 'working').replace(/\s+/g, '-')}`} />
              <strong>{followedRun.ref} · {PHASE_LABEL[followedRun.derivedPhase] ?? followedRun.status}</strong>
              {followedRun.runId && <code>{followedRun.runId}</code>}
              {followedRun.worktree && <code data-testid="followed-run-worktree">{followedRun.worktree}</code>}
              <button onClick={() => setActiveView('board')}>Ver quadro →</button>
            </div>
          )}

          <div className="terminal-workspace" data-testid="terminal-view">
            {activePaneId ? <><div className="terminal-caption"><span>{activeTerminal?.launcher ?? 'Terminal'} · {activeTerminal?.status === 'exited' ? 'Sessão encerrada' : activeTerminal?.launcher === 'shell' ? 'Shell do sistema' : 'Sessão CLI independente'}</span><code>{activeTerminal?.worktreePath ?? activeProject?.path}</code></div><div className="terminal-surface"><div ref={terminalContainerRef} className="terminal-emulator" aria-label="Terminal interativo" /></div><details className="terminal-tools"><summary>Teclas e envio de comando</summary><form className="terminal-command" onSubmit={(event) => { event.preventDefault(); void handleTerminalCommand(); }}><label htmlFor="terminal-command">Enviar ao terminal</label><input id="terminal-command" value={terminalInput} onChange={(event) => setTerminalInput(event.target.value)} placeholder="Mensagem ou comando para este terminal" /><button type="submit" disabled={!activePaneId}>Enviar</button></form><div className="virtual-keybar" data-testid="virtual-keybar">{[['esc', '\x1b'], ['tab', '\t'], ['^C', '\x03'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C']].map(([label, key]) => <button key={label} className="btn-key" onClick={() => void handleVirtualKey(key)}>{label}</button>)}</div></details></> : <div className="chat-empty"><h1>Abra uma sessão de terminal</h1><p>Use + Terminal para abrir o shell do sistema neste projeto.</p></div>}
          </div>
        </div>;
        })()}

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
            <div className="role-settings">
              {['plan', 'implement', 'review', 'critic'].map((role) => <label key={role} className="command-setting">Comando global para {role}
                <input aria-label={`Comando global para ${role}`} value={globalRoles[role]?.command ?? ''} onChange={(event) => setGlobalRoles((current) => ({ ...current, [role]: { command: event.target.value } }))} />
              </label>)}
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
          <section onKeyDown={(event) => { if (event.key === 'Escape') setProjectSettingsId(null); }} className="project-dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="project-settings-title">
            <div className="dialog-heading"><h2 id="project-settings-title">Configurações de {projects.find((project) => project.id === projectSettingsId)?.name ?? 'projeto'}</h2><button aria-label="Fechar configurações do projeto" onClick={() => setProjectSettingsId(null)}>×</button></div>
            {activeProjectId === projectSettingsId && setupProjectLoaded.current === projectSettingsId ? (
<div data-testid="setup-panel">
              <p>Informe o caminho do executável que o pack vai abrir em cada papel. O comando do projeto tem prioridade sobre o global. Os comandos salvos aqui são locais a esta máquina. Campos vazios usam o comando do repositório, quando existir, ou o global.</p>
              {feedback && <p role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}</p>}
              <div className="role-settings">
                {['plan', 'implement', 'review', 'critic'].map((role) => <label key={role} className="command-setting">Comando para {role}
                  <input aria-label={`Comando para ${role}`} placeholder={globalRoles[role]?.command || 'Caminho do executável'} value={roleSelections[role]?.command ?? ''} onChange={(event) => setRoleSelections((current) => ({ ...current, [role]: { command: event.target.value } }))} />
                  <small>Global: {globalRoles[role]?.command || 'não configurado'}</small>
                </label>)}
              </div>
              <button data-testid="apply-project-commands" onClick={() => void handleApplySetup()}>Salvar comandos do projeto</button>
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
