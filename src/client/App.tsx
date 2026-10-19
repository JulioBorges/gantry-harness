import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useActionFeedback } from './useActionFeedback.js';
import { FileViewerDialog } from './FileViewerDialog.js';
import { FileTree, type FileTreeEntry } from './FileTree.js';
import type { ExecutionSettings, RoleSelection } from '../types.js';
import type { ManagedPane } from '../server/ptyManager.js';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { TerminalSettings, TerminalEnvironment } from '../types.js';
import { SettingsDialog, type SettingsTab } from './SettingsDialog.js';
import { SystemFontSelect } from './SystemFontSelect.js';
import type { LiveBadgeState, RegisteredProject } from '../types.js';

export interface AppProps {
  apiBaseUrl?: string;
}

declare global {
  interface Window {
    gantryDesktop?: { platform: string; chooseDirectory: () => Promise<string | null> };
  }
}

const STATUS_LABELS: Record<string, string> = {
  working: 'Em execução',
  'needs input': 'Aguardando você',
  done: 'Concluído',
  blocked: 'Bloqueado',
  idle: 'Pronto',
};

export function App({ apiBaseUrl = '' }: AppProps): React.ReactElement {
  const [projects, setProjects] = useState<RegisteredProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
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
    }>;
    remediationCards: Array<{ kind: string; title: string; description: string; remediation: string }>;
  } | null>(null);
  const [activeView, setActiveView] = useState<'terminal' | 'files'>('terminal');
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
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [terminalBuffer, setTerminalBuffer] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [artifactDrawer, setArtifactDrawer] = useState<{ projectId: string; path: string; content: string; diff: string } | null>(null);
  const [setupDiffPreview, setSetupDiffPreview] = useState('');
  const [setupHostHarness, setSetupHostHarness] = useState('opencode');
  const [discoveredModels, setDiscoveredModels] = useState<Array<{ id: string }>>([]);
  const [roleSelections, setRoleSelections] = useState<Record<string, RoleSelection>>({});
  const setupProjectLoaded = useRef<string | null>(null);
  const { feedback, pendingActions, withFeedback, reportError } = useActionFeedback();
  const [terminalInput, setTerminalInput] = useState('');
  const [panes, setPanes] = useState<ManagedPane[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 760);
  const [wideWorkspace, setWideWorkspace] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 760);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [requiresRemotePairing, setRequiresRemotePairing] = useState(false);
  const [enteredPairingCode, setEnteredPairingCode] = useState('');
  const [authToken, setAuthToken] = useState(() => {
    try {
      return typeof localStorage !== 'undefined' ? (localStorage.getItem('gantry_auth_token') ?? '') : '';
    } catch {
      return '';
    }
  });
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const terminalWrittenLength = useRef(0);
  const selectedPane = useRef({ projectId: activeProjectId, paneId: activePaneId });
  selectedPane.current = { projectId: activeProjectId, paneId: activePaneId };
  const workspaceLoading = useRef(false);
  const workspaceReloadRequested = useRef(false);
  const base = apiBaseUrl.replace(/\/$/, '');

  const apiFetch = useCallback(async (urlPath: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers ?? {});
    if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
    let response: Response;
    try {
      response = await fetch(`${base}${urlPath}`, { ...init, headers });
    } catch {
      throw new Error('Não foi possível acessar o servidor. Verifique se bun start está em execução e tente novamente.');
    }
    if (response.status === 401 && urlPath !== '/api/auth/pair/verify') setRequiresRemotePairing(true);
    if (!response.ok) {
      const data = await response.clone().json().catch(() => ({}));
      throw new Error(data.error ?? `A solicitação falhou (HTTP ${response.status}). Tente novamente.`);
    }
    return response;
  }, [base, authToken]);

  const loadArtifactAsset = useCallback(async (assetPath: string, signal: AbortSignal): Promise<Blob> => {
    if (!artifactDrawer) throw new Error('Nenhum arquivo selecionado.');
    const response = await apiFetch(`/api/projects/${artifactDrawer.projectId}/artifact-assets?path=${encodeURIComponent(assetPath)}`, { signal });
    return response.blob();
  }, [apiFetch, artifactDrawer?.projectId]);

  const loadWorkspaceState = async (): Promise<void> => {
    if (workspaceLoading.current) {
      workspaceReloadRequested.current = true;
      return;
    }
    workspaceLoading.current = true;
    try {
      const res = await apiFetch('/api/workspace/state');
      if (res.status === 401) {
        setRequiresRemotePairing(true);
        return;
      }
      if (!res.ok) return;
      setRequiresRemotePairing(false);
      const data = await res.json();
      if (data.terminalEnvironment) setTerminalEnvironment(data.terminalEnvironment);
      if (!terminalSettingsLoaded.current && data.terminalSettings) {
        setTerminalSettings(data.terminalSettings);
        setTerminalDraft(data.terminalSettings);
        terminalSettingsLoaded.current = true;
      }
      const projs: RegisteredProject[] = data.projects ?? [];
      setProjects(projs);
      const actProj = data.layout?.activeProjectId ?? projs[0]?.id ?? null;
      setActiveProjectId(actProj);
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
      } else {
        setPanes([]);
        setInspection(null);
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
    void loadWorkspaceState();
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
          } else if (payload.type !== 'pane.input') {
            void loadWorkspaceState();
          }
        } catch {
          // ignore malformed socket payloads
        }
      };
    } catch {
      // ignore if WebSocket unavailable
    }
    return () => { ws?.close(); };
  }, [apiBaseUrl, authToken]);

  useEffect(() => {
    if (activeView !== 'terminal' || !activePaneId || !terminalContainerRef.current) return;
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
  }, [activePaneId, activeView]);

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
    setActivePaneId(paneId);
    setTerminalBuffer(pane.terminalBuffer);
    setActiveView('terminal');
  });

  const handleClosePane = withFeedback('Encerrar terminal', async (paneId: string) => {
    if (!activeProjectId) return;
    if (paneId === activePaneId) {
      selectedPane.current = { ...selectedPane.current, paneId: null };
      setActivePaneId(null);
      setTerminalBuffer('');
    }
    await apiFetch(`/api/projects/${activeProjectId}/panes/${paneId}`, { method: 'DELETE' });
    await loadWorkspaceState();
  });

  const handleAddProject = withFeedback('Adicionar projeto', async (): Promise<void> => {
    if (!newProjectPath.trim()) throw new Error('Informe o diretório do projeto. Você pode usar ~/src/meu-projeto.');
    const res = await apiFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newProjectPath.trim() }),
    });
    if (res.ok) {
      const result = await res.json();
      await apiFetch('/api/workspace/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeProjectId: result.project.id }),
      });
      setNewProjectPath('');
      setProjectDialogOpen(false);
      if (window.innerWidth < 760) setSidebarOpen(false);
      setActiveView('terminal');
      await loadWorkspaceState();
    }
  });

  const handleSelectProject = withFeedback('Selecionar projeto', async (projectId: string): Promise<void> => {
    setArtifactDrawer(null);
    setActivePaneId(null);
    setTerminalBuffer('');
    if (window.innerWidth < 760) setSidebarOpen(false);
    setActiveView('terminal');
    setActiveProjectId(projectId);
    await apiFetch('/api/workspace/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeProjectId: projectId }),
    });
    await loadWorkspaceState();
  });

  const handleOpenTerminal = withFeedback('Abrir terminal', async (): Promise<void> => {
    if (!activeProjectId) throw new Error('Adicione ou selecione um projeto antes de abrir um terminal.');
    const paneId = `pane-shell-${Date.now()}`;
    const res = await apiFetch(`/api/projects/${activeProjectId}/panes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paneId, launcher: 'shell', mode: 'terminal' }),
    });
    if (res.ok) {
      const data = await res.json();
      setActivePaneId(data.pane.paneId);
      setTerminalBuffer(data.pane.terminalBuffer ?? '');
      setActiveView('terminal');
      await loadWorkspaceState();
    }
  });

  const handleToggleChatTerminal = withFeedback('Alternar conversa e terminal', async (): Promise<void> => {
    const shellPane = panes.find((pane) => pane.paneId === activePaneId && pane.launcher === 'shell' && pane.status === 'running')
      ?? panes.find((pane) => pane.launcher === 'shell' && pane.status === 'running');
    if (activeProjectId && shellPane) {
      await handleSelectPane(shellPane.paneId);
      return;
    }
    await handleOpenTerminal();
  });

  const handleVirtualKey = withFeedback('Enviar tecla', async (keySeq: string): Promise<void> => {
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
    const res = await apiFetch(`/api/projects/${activeProjectId}/artifacts?path=${encodeURIComponent(relPath)}&diff=true`);
    if (res.ok) {
      const artifact = await res.json();
      if (selectedPane.current.projectId === activeProjectId) setArtifactDrawer({ ...artifact, projectId: activeProjectId });
    }
  };
  const handleOpenArtifact = withFeedback('Abrir arquivo', loadArtifact);

  const handleSaveArtifact = async (content: string): Promise<void> => {
    if (!artifactDrawer) return;
    const { projectId, path: artifactPath } = artifactDrawer;
    await apiFetch(`/api/projects/${projectId}/artifacts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: artifactPath, content }),
    });
    const refreshed = await apiFetch(`/api/projects/${projectId}/artifacts?path=${encodeURIComponent(artifactPath)}&diff=true`);
    const artifact = await refreshed.json();
    setArtifactDrawer((current) => current?.projectId === projectId && current.path === artifactPath ? { ...artifact, projectId } : current);
  };

  const buildProposedPolicy = (): Record<string, unknown> => {
    if (!setupHostHarness) throw new Error('Selecione o host do projeto antes de salvar a configuração.');
    const policy = inspection?.policy ?? {};
    return { ...policy, execution: { ...policy.execution, hostHarness: setupHostHarness, roles: roleSelections } };
  };

  const handlePreviewSetup = withFeedback('Prévia da configuração', async (): Promise<void> => {
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

  const handleApplySetup = withFeedback('Salvar configuração do projeto', async (scope: 'repository' | 'personal'): Promise<void> => {
    if (!activeProjectId) throw new Error('Selecione um projeto para continuar.');
    for (const [role, selection] of Object.entries(roleSelections)) {
      if (!selection.model.trim()) throw new Error(`Informe o modelo para o papel ${role}. Consulte os modelos do host antes de salvar.`);
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

  const handleBootstrap = withFeedback('Instalar skills do Gantry', async () => {
    if (!activeProjectId) throw new Error('Selecione um projeto primeiro.');
    await apiFetch(`/api/projects/${activeProjectId}/bootstrap`, { method: 'POST' });
    await loadWorkspaceState();
  });

  const handleDiscoverModels = withFeedback('Consultar modelos do host', async () => {
    if (!activeProjectId || !setupHostHarness) throw new Error('Selecione um projeto e seu host primeiro.');
    const response = await apiFetch(`/api/projects/${activeProjectId}/discovery?harness=${encodeURIComponent(setupHostHarness)}`);
    const data = await response.json();
    setDiscoveredModels(data.models ?? []);
    if (!data.models?.length) throw new Error('O host não retornou modelos verificáveis. Verifique instalação e autenticação.');
  });

  const handleSaveTerminalSettings = withFeedback('Salvar terminal', async () => {
    const response = await apiFetch('/api/settings/terminal', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(terminalDraft),
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: `${terminalInput}\r` }),
    });
    setTerminalInput('');
  });

  const handleVerifyPairingCode = withFeedback('Conectar dispositivo', async (): Promise<void> => {
    const res = await apiFetch('/api/auth/pair/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: enteredPairingCode.trim() }),
    });
    if (res.ok) {
      const data = await res.json();
      setAuthToken(data.token);
      try { localStorage.setItem('gantry_auth_token', data.token); } catch { /* ignore storage failures */ }
      setRequiresRemotePairing(false);
    }
  });

  if (requiresRemotePairing) {
    return (
      <div data-testid="remote-pairing-screen" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 12 }}>
        <h2>Gantry Harness — Remote Tailscale / LAN Pairing</h2>
        {feedback?.kind === 'error' && <p role="alert">{feedback.message}</p>}
        <p>Enter the 6-digit One-Time Pairing Code displayed in your terminal or Settings:</p>
        <input data-testid="pairing-code-input" placeholder="6-digit code" value={enteredPairingCode} onChange={(event) => setEnteredPairingCode(event.target.value)} />
        <button data-testid="pairing-verify-btn" onClick={() => void handleVerifyPairingCode()}>Verify & Connect</button>
      </div>
    );
  }

  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeTerminal = panes.find((pane) => pane.paneId === activePaneId);
  const inlineArtifact = activeView === 'files' && wideWorkspace && artifactDrawer?.projectId === activeProjectId ? artifactDrawer : null;
  const changeView = (view: typeof activeView) => { setActiveView(view); if (window.innerWidth < 760) setSidebarOpen(false); };

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
          {projects.map((project) => <div key={project.id}>
            <button className={`project-row ${project.id === activeProjectId ? 'selected' : ''}`} onClick={() => void handleSelectProject(project.id)} aria-current={project.id === activeProjectId ? 'page' : undefined}>
              <span className="folder-icon" aria-hidden="true">▱</span>
              <span className="project-row-text"><strong>{project.name}</strong><small title={project.path}>{project.path}</small></span>
              <span title={STATUS_LABELS[project.badgeState]} className={`status-dot ${project.badgeState?.replace(/\s+/g, '-')}`} />
            </button>
            {project.id === activeProjectId && inspection && inspection.worktrees.length > 0 && <details className="project-context">
              <summary>Worktrees</summary>
              {inspection.worktrees.map((wt) => <div key={wt.path} className="worktree-row"><span title={wt.path}>{wt.branch} · {STATUS_LABELS[wt.badgeState]}</span></div>)}
            </details>}
          </div>)}
        </div>
        <button className="new-project-link" onClick={() => setProjectDialogOpen(true)}>+ Abrir projeto</button>
        <div className="sidebar-bottom">
          <button className="btn-nav" data-testid="open-settings-btn" onClick={() => openSettings('terminal')}>Configurações</button>
          <div className="local-caption">Armazenamento local · v0.1.0</div>
        </div>
      </aside>

      <main className="main-area">
        <header className="workspace-header">
          <button className="icon-button navigation-toggle" aria-label="Alternar navegação" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((value) => !value)}>☰</button>
          <div className="workspace-title"><strong>{activeProject?.name ?? 'Gantry Harness'}</strong><span title={activeProject?.path}>{activeProject?.path ?? 'Seu workspace de desenvolvimento'}</span></div>
          <div className="view-selector" aria-label="Área de trabalho">
            <button data-testid="chat-terminal-toggle" aria-pressed={activeView === 'terminal'} disabled={!activeProjectId || pendingActions.includes('Abrir terminal')} onClick={() => { setActiveView('terminal'); void handleToggleChatTerminal(); }}>Terminal</button>
            <button data-testid="open-files-btn" aria-pressed={activeView === 'files'} onClick={() => changeView('files')}>Files</button>
          </div>
        </header>

        {pendingActions.length > 0 && <div className="action-pending" role="status" aria-live="polite"><span className="working-indicator" />{pendingActions.join(' · ')}…</div>}
        {feedback?.kind === 'error' && !projectDialogOpen && !settingsOpen && <div className="action-feedback error" role="alert"><p>{feedback.message}</p></div>}

        {activeView === 'terminal' && <div className="workspace-content">
          <div className="session-bar">
            <div className="session-tabs" aria-label="Terminais">
              {panes.map((pane) => <div key={pane.paneId} className={`terminal-tab ${pane.paneId === activePaneId ? 'active' : ''}`}><button onClick={() => void handleSelectPane(pane.paneId)}><span className={`status-dot ${pane.status === 'running' ? 'done' : 'idle'}`} />{pane.launcher}<small>{pane.status === 'exited' ? `Encerrado (${pane.exitCode ?? '—'})` : 'Em execução'}</small></button><button className="tab-close" aria-label={`Encerrar terminal ${pane.launcher}`} onClick={() => void handleClosePane(pane.paneId)}>×</button></div>)}
            </div>
            <button className="new-terminal-button" data-testid="launcher-shell" disabled={!activeProjectId || pendingActions.includes('Abrir terminal')} onClick={() => void handleOpenTerminal()}>+ Terminal</button>
          </div>
          <div className="terminal-workspace" data-testid="terminal-view">
            {activePaneId ? <>
              <div className="terminal-caption"><span>{activeTerminal?.launcher ?? 'Terminal'} · {activeTerminal?.status === 'exited' ? 'Sessão encerrada' : activeTerminal?.launcher === 'shell' ? 'Shell do sistema' : 'Sessão CLI independente'}</span><code>{activeTerminal?.worktreePath ?? activeProject?.path}</code></div>
              <div className="terminal-surface"><div ref={terminalContainerRef} className="terminal-emulator" aria-label="Terminal interativo" /></div>
              <details className="terminal-tools"><summary>Teclas e envio de comando</summary>
                <form className="terminal-command" onSubmit={(event) => { event.preventDefault(); void handleTerminalCommand(); }}>
                  <label htmlFor="terminal-command">Enviar ao terminal</label>
                  <input id="terminal-command" value={terminalInput} onChange={(event) => setTerminalInput(event.target.value)} placeholder="Mensagem ou comando para este terminal" />
                  <button type="submit" disabled={!activePaneId}>Enviar</button>
                </form>
                <div className="virtual-keybar" data-testid="virtual-keybar">{[['esc', '\x1b'], ['tab', '\t'], ['^C', '\x03'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C']].map(([label, key]) => <button key={label} className="btn-key" onClick={() => void handleVirtualKey(key)}>{label}</button>)}</div>
              </details>
            </> : <div className="chat-empty"><h1>Abra uma sessão de terminal</h1><p>Abra o shell do sistema para executar comandos ou restaurar sessões do Codex, Claude e OpenCode com os parâmetros que preferir.</p><button onClick={() => void handleOpenTerminal()}>Abrir shell</button></div>}
          </div>
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
          {settingsTab === 'project' && (activeProjectId ? (
            <div data-testid="setup-panel" style={{ padding: 16, overflowY: 'auto' }}>
              <h2>Papéis de execução</h2>
              <p className="section-intro">Confira o host e os modelos de cada papel. O pack consome essa configuração; o harness não chama um modelo por conta própria.</p>
              {inspection?.remediationCards.map((card) => <div key={card.kind} className="setup-diagnostic"><strong>{card.title}</strong><p>{card.description}</p><p>{card.remediation}</p></div>)}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <button data-testid="bootstrap-skills-btn" disabled={!activeProjectId || pendingActions.includes('Instalar skills do Gantry')} onClick={() => void handleBootstrap()}>Instalar / atualizar skills do Gantry</button>
                <button data-testid="discover-models-btn" disabled={!activeProjectId || !setupHostHarness || pendingActions.includes('Consultar modelos do host')} onClick={() => void handleDiscoverModels()}>Consultar modelos do host</button>
              </div>
              {discoveredModels.length > 0 && <div className="model-results">Modelos encontrados: {discoveredModels.map((model) => model.id).join(', ')}</div>}
              <div>
                <label>Host do projeto:{' '}
                  <select value={setupHostHarness} onChange={(event) => setSetupHostHarness(event.target.value)}>
                    <option value="">Selecione o host</option>
                    <option value="opencode">opencode</option>
                    <option value="claude-code">claude-code</option>
                    <option value="codex">codex</option>
                    <option value="antigravity">antigravity</option>
                  </select>
                </label>
              </div>
              <div className="role-settings">
                <h3>Modelos por papel</h3>
                {Object.entries(roleSelections).map(([role, selection]) => <div key={role} className="role-setting-row">
                  <strong>{role}</strong>
                  <label>Host<input aria-label={`Host para ${role}`} value={selection.harness} onChange={(event) => setRoleSelections((current) => ({ ...current, [role]: { ...selection, harness: event.target.value } }))} /></label>
                  <label>Modelo<input aria-label={`Modelo para ${role}`} list="verified-models" value={selection.model} onChange={(event) => setRoleSelections((current) => ({ ...current, [role]: { ...selection, model: event.target.value } }))} /></label>
                  <label>Esforço<input aria-label={`Esforço para ${role}`} value={selection.effort ?? ''} onChange={(event) => setRoleSelections((current) => ({ ...current, [role]: { ...selection, effort: event.target.value } }))} /></label>
                </div>)}
                <datalist id="verified-models">{discoveredModels.map((model) => <option key={model.id} value={model.id} />)}</datalist>
                {Object.keys(roleSelections).length === 0 && <button disabled={!setupHostHarness} onClick={() => setRoleSelections(Object.fromEntries(['plan', 'implement', 'review', 'critic'].map((role) => [role, { harness: setupHostHarness, model: '' }])))}>Configurar papéis de execução</button>}
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button data-testid="preview-setup-btn" onClick={() => void handlePreviewSetup()}>Revisar prévia das alterações</button>
                <button data-testid="apply-repo-setup-btn" onClick={() => void handleApplySetup('repository')}>Salvar no repositório</button>
                <button data-testid="apply-personal-setup-btn" onClick={() => void handleApplySetup('personal')}>Salvar apenas no perfil pessoal</button>
              </div>
              {setupDiffPreview && <pre data-testid="setup-diff-preview" style={{ marginTop: 12 }}>{setupDiffPreview}</pre>}
            </div>
          ) : <p className="settings-empty">Abra um projeto para configurar o host e os papéis de execução.</p>)}
          {settingsTab === 'remote' && <section className="settings-panel remote-settings">
            <h2>Acesso remoto por código</h2>
            <p>Gere um código para conectar outro dispositivo pela sua rede ou Tailscale.</p>
            <button disabled={pendingActions.includes('Gerar código de acesso')} onClick={() => void handleGeneratePairing()}>Gerar código de acesso</button>
            {pairingCode && <div data-testid="pairing-code-display">Código: {pairingCode}</div>}
          </section>}
        </SettingsDialog>}

        {artifactDrawer && !inlineArtifact && <FileViewerDialog key={`${artifactDrawer.projectId}:${artifactDrawer.path}`} artifact={artifactDrawer} onClose={() => setArtifactDrawer(null)} onSave={handleSaveArtifact} onOpenFile={loadArtifact} onLoadAsset={loadArtifactAsset} />}
      </main>
      {projectDialogOpen && <div className="dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) setProjectDialogOpen(false); }}><section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" onKeyDown={(event) => { if (event.key === 'Tab') { const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input')); const first = controls[0]; const last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } }}><div className="dialog-heading"><h2 id="project-dialog-title">Abrir projeto</h2><button aria-label="Fechar diálogo" onClick={() => setProjectDialogOpen(false)}>×</button></div><p>Escolha uma pasta local. As configurações do Gantry serão carregadas a partir dela.</p>{feedback?.kind === 'error' && <p role="alert" className="dialog-error">{feedback.message}</p>}<label htmlFor="new-project-path">Diretório do projeto</label><div className="directory-field"><input id="new-project-path" placeholder="/path/to/repo" value={newProjectPath} onChange={(event) => setNewProjectPath(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void handleAddProject(); }} />{window.gantryDesktop && <button onClick={() => void handleChooseDirectory()}>Escolher pasta</button>}</div><div className="dialog-actions"><button onClick={() => setProjectDialogOpen(false)}>Cancelar</button><button className="btn-primary" data-testid="add-project-btn" disabled={pendingActions.includes('Adicionar projeto')} onClick={() => void handleAddProject()}>Abrir projeto</button></div></section></div>}
    </div>
  );
}
