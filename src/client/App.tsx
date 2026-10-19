import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useActionFeedback } from './useActionFeedback.js';
import { FileViewerDialog } from './FileViewerDialog.js';
import { FileTree, type FileTreeEntry } from './FileTree.js';
import { BoardView } from './BoardView.js';
import type { ExecutionSettings } from '../types.js';
import type { ManagedPane } from '../server/ptyManager.js';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { TerminalSettings, TerminalEnvironment } from '../types.js';
import { SettingsDialog, type SettingsTab } from './SettingsDialog.js';
import { SystemFontSelect } from './SystemFontSelect.js';
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

const STATUS_LABELS: Record<string, string> = {
  working: 'Em execução',
  'needs input': 'Aguardando você',
  done: 'Concluído',
  blocked: 'Bloqueado',
  idle: 'Pronto'
};

const CLICKABLE_PATH_RE = /\b([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|py|md|json|css|html))\b/g;

export function App({ apiBaseUrl = '' }: AppProps): React.ReactElement {
  const [projects, setProjects] = useState<RegisteredProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'board' | 'terminal'>('board');

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

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('terminal');
  const openSettings = (tab: SettingsTab) => { setSettingsTab(tab); setSettingsOpen(true); };
  const [terminalSettings, setTerminalSettings] = useState<TerminalSettings>({
    fontFamily: 'Menlo, Consolas, monospace',
    fontSize: 13,
    shell: 'system'
  });
  const [terminalDraft, setTerminalDraft] = useState(terminalSettings);
  const [terminalEnvironment, setTerminalEnvironment] = useState<TerminalEnvironment | null>(null);
  const terminalSettingsLoaded = useRef(false);
  const terminalAppearance = useRef(terminalSettings);
  terminalAppearance.current = terminalSettings;
  const fitAddonRef = useRef<FitAddon | null>(null);

  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [panes, setPanes] = useState<ManagedPane[]>([]);
  const paneTerminals = useRef<Map<string, Terminal>>(new Map());
  const fitAddons = useRef<Map<string, FitAddon>>(new Map());

  const [selectedFile, setSelectedFile] = useState<FileTreeEntry | null>(null);
  const [fileViewerOpen, setFileViewerOpen] = useState(false);
  const [fileTree, setFileTree] = useState<FileTreeEntry[]>([]);

  const { feedback, pendingActions, withFeedback, reportError, dismissFeedback } = useActionFeedback();
  const feedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Fetch projects on mount
  useEffect(() => {
    fetch(`${apiBaseUrl}/api/projects`)
      .then((r) => r.json())
      .then((data) => {
        const projects = data.projects ?? [];
        setProjects(projects);
        if (projects.length > 0 && !activeProjectId) {
          setActiveProjectId(projects[0].id);
        }
      })
      .catch(console.error);
  }, [apiBaseUrl, activeProjectId]);

  // Fetch terminal settings
  useEffect(() => {
    if (terminalSettingsLoaded.current) return;
    fetch(`${apiBaseUrl}/api/settings/terminal`)
      .then((r) => r.json())
      .then((data) => {
        terminalSettingsLoaded.current = true;
        setTerminalSettings(data.settings);
        setTerminalDraft(data.settings);
        setTerminalEnvironment(data.environment);
      })
      .catch(console.error);
  }, [apiBaseUrl]);

  // WebSocket connection
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}${apiBaseUrl}/ws`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'project.registered') {
        setProjects((prev) => {
          const exists = prev.find((p) => p.id === msg.project.id);
          return exists ? prev : [...prev, msg.project];
        });
      } else if (msg.type === 'project.unregistered') {
        setProjects((prev) => prev.filter((p) => p.id !== msg.projectId));
        if (activeProjectId === msg.projectId) {
          setActiveProjectId(null);
        }
      }
    };

    return () => { ws.close(); };
  }, [apiBaseUrl, activeProjectId]);

  // Fetch panes when active project changes
  useEffect(() => {
    if (!activeProjectId) return;
    fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/panes`)
      .then((r) => r.json())
      .then((data) => {
        setPanes(data.panes ?? []);
        if (data.panes?.length > 0 && !activePaneId) {
          setActivePaneId(data.panes[0].id);
        }
      })
      .catch(console.error);
  }, [activeProjectId, apiBaseUrl, activePaneId]);

  // Fetch file tree when active project changes
  useEffect(() => {
    if (!activeProjectId) return;
    fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/tree`)
      .then((r) => r.json())
      .then((data) => setFileTree(data.tree ?? []))
      .catch(console.error);
  }, [activeProjectId, apiBaseUrl]);

  // Fetch inspection data
  useEffect(() => {
    if (!activeProjectId) return;
    fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/inspect`)
      .then((r) => r.json())
      .then((data) => setInspection(data))
      .catch(console.error);
  }, [activeProjectId, apiBaseUrl]);

  const handleAddProject = async () => {
    if (window.gantryDesktop?.chooseDirectory) {
      const dir = await window.gantryDesktop.chooseDirectory();
      if (dir) {
        await fetch(`${apiBaseUrl}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dir }),
        });
        // Project registered
      }
    } else {
      const dir = prompt('Digite o caminho do projeto:');
      if (dir) {
        await fetch(`${apiBaseUrl}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dir }),
        });
        // Project registered
      }
    }
  };

  const handleRemoveProject = async (projectId: string) => {
    if (confirm('Remover este projeto?')) {
      await fetch(`${apiBaseUrl}/api/projects/${projectId}`, { method: 'DELETE' });
      // Project removed
    }
  };

  const handleCreatePane = async () => {
    if (!activeProjectId) return;
    const title = prompt('Nome do terminal:');
    if (!title) return;
    await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/panes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    // Pane created
  };

  const handleFileSelect = (file: FileTreeEntry) => {
    setSelectedFile(file);
    setFileViewerOpen(true);
  };

  const handleSaveTerminalSettings = async () => {
    await fetch(`${apiBaseUrl}/api/settings/terminal`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: terminalDraft }),
    });
    setTerminalSettings(terminalDraft);
    setSettingsOpen(false);
    // Settings saved

    // Refit all terminals
    setTimeout(() => {
      fitAddons.current.forEach((fit) => fit.fit());
    }, 100);
  };

  const activeProject = projects.find((p) => p.id === activeProjectId);

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: '#0F172A', color: '#F8FAFC' }}>
      {/* Sidebar */}
      <div style={{ width: 280, background: '#1E293B', borderRight: '1px solid #334155', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 16, borderBottom: '1px solid #334155' }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Gantry Harness</h1>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#94A3B8' }}>Terminal Supervisor</p>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          <div style={{ padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#94A3B8' }}>PROJETOS</span>
              <button onClick={handleAddProject} style={{ background: 'none', border: 'none', color: '#38BDF8', cursor: 'pointer', fontSize: 16 }}>+</button>
            </div>
            {projects.map((proj) => (
              <div
                key={proj.id}
                onClick={() => setActiveProjectId(proj.id)}
                style={{
                  padding: 8,
                  borderRadius: 6,
                  background: proj.id === activeProjectId ? '#334155' : 'transparent',
                  cursor: 'pointer',
                  marginBottom: 4,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span style={{ fontSize: 13 }}>{proj.name}</span>
                <button onClick={(e) => { e.stopPropagation(); handleRemoveProject(proj.id); }} style={{ background: 'none', border: 'none', color: '#F87171', cursor: 'pointer', fontSize: 12 }}>×</button>
              </div>
            ))}
          </div>
        </div>

        <div style={{ padding: 12, borderTop: '1px solid #334155' }}>
          <button onClick={() => openSettings('terminal')} style={{ width: '100%', padding: 8, background: '#334155', border: 'none', borderRadius: 6, color: '#F8FAFC', cursor: 'pointer', fontSize: 13 }}>
            Configurações
          </button>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {activeProject ? (
          <>
            <div style={{ padding: 16, borderBottom: '1px solid #334155' }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{activeProject.name}</h2>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#94A3B8' }}>{activeProject.path}</p>
            </div>

            <div className="view-selector" style={{ margin: '8px 16px', alignSelf: 'flex-start' }}>
              <button type="button" aria-pressed={activeView === 'board'} onClick={() => setActiveView('board')}>
                Board
              </button>
              <button type="button" aria-pressed={activeView === 'terminal'} onClick={() => setActiveView('terminal')}>
                Terminal
              </button>
            </div>

            <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minWidth: 0, minHeight: 0 }}>
              {activeView === 'board' ? (
                activeProjectId ? <BoardView projectId={activeProjectId} apiBaseUrl={apiBaseUrl} /> : null
              ) : (
                <>
                  {/* File tree */}
                  <div style={{ width: 240, background: '#1E293B', borderRight: '1px solid #334155', overflow: 'auto', padding: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#94A3B8', marginBottom: 8 }}>ARQUIVOS</div>
                    <FileTree
                      projectId={activeProjectId}
                      projectName={activeProject.name}
                      loadEntries={async (path: string, query: string) => {
                        const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/tree?path=${encodeURIComponent(path)}&q=${encodeURIComponent(query)}`);
                        return response.json();
                      }}
                      onOpenFile={(path) => {
                        setSelectedFile({ name: path.split('/').pop() || path, path, kind: 'file' });
                        setFileViewerOpen(true);
                      }}
                      selectedPath={selectedFile?.path}
                    />
                  </div>

                  {/* Terminal area */}
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <div style={{ padding: 12, borderBottom: '1px solid #334155', display: 'flex', gap: 8, alignItems: 'center' }}>
                      {panes.map((pane) => (
                        <button
                          key={pane.paneId}
                          onClick={() => setActivePaneId(pane.paneId)}
                          style={{
                            padding: '6px 12px',
                            background: pane.paneId === activePaneId ? '#334155' : 'transparent',
                            border: '1px solid #334155',
                            borderRadius: 6,
                            color: '#F8FAFC',
                            cursor: 'pointer',
                            fontSize: 12,
                          }}
                        >
                          {pane.launcher || 'Terminal'}
                        </button>
                      ))}
                      <button onClick={handleCreatePane} style={{ padding: '6px 12px', background: '#38BDF8', border: 'none', borderRadius: 6, color: '#0F172A', cursor: 'pointer', fontSize: 12 }}>
                        + Terminal
                      </button>
                    </div>

                    <div style={{ flex: 1, background: '#0B0E14', padding: 16 }}>
                      {activePaneId ? (
                        <div style={{ height: '100%' }} id={`terminal-${activePaneId}`} />
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#94A3B8' }}>
                          Selecione ou crie um terminal
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, flexDirection: 'column', gap: 16 }}>
            <p style={{ color: '#94A3B8' }}>Nenhum projeto selecionado</p>
            <button onClick={handleAddProject} style={{ padding: '8px 16px', background: '#38BDF8', border: 'none', borderRadius: 6, color: '#0F172A', cursor: 'pointer', fontSize: 14 }}>
              Adicionar Projeto
            </button>
          </div>
        )}
      </div>

      {/* Dialogs */}
      {settingsOpen && (
        <SettingsDialog
          tab={settingsTab}
          onTabChange={setSettingsTab}
          onClose={() => setSettingsOpen(false)}
        >
          {settingsTab === 'terminal' && (
            <div style={{ padding: 16 }}>
              <h3>Configurações do Terminal</h3>
              <p style={{ color: '#94A3B8', marginTop: 8 }}>Configurações de terminal virão aqui.</p>
            </div>
          )}
          {settingsTab === 'ai' && (
            <div style={{ padding: 16 }}>
              <h3>Conexão de IA</h3>
              <p style={{ color: '#94A3B8', marginTop: 8 }}>Configurações de IA removidas (orquestrador excised).</p>
            </div>
          )}
        </SettingsDialog>
      )}

      {fileViewerOpen && selectedFile && (
        <FileViewerDialog
          artifact={{
            path: selectedFile.path,
            content: '', // Will be loaded by the component
            diff: '',
          }}
          onClose={() => setFileViewerOpen(false)}
          onSave={async (content: string) => {
            // TODO: Implement file save
            console.log('Save file:', selectedFile.path, content);
          }}
        />
      )}

      {/* Feedback */}
      {feedback && (
        <div style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          padding: '12px 16px',
          background: feedback.kind === 'success' ? '#10B981' : '#F87171',
          color: '#FFF',
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 500,
        }}>
          {feedback.message}
        </div>
      )}
    </div>
  );
}
