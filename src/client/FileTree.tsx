import React, { useEffect, useState } from 'react';

export interface FileTreeEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
}

interface FileTreeProps {
  projectId: string | null;
  projectName: string;
  loadEntries: (relativePath: string, query: string) => Promise<FileTreeEntry[]>;
  onOpenFile: (path: string) => void;
  onOpenProject?: () => void;
  selectedPath?: string | null;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível listar os arquivos.';
}

function parentPath(entry: FileTreeEntry): string {
  const index = entry.path.lastIndexOf('/');
  return index === -1 ? '' : entry.path.slice(0, index);
}

function iconKind(entry: FileTreeEntry): 'folder' | 'markdown' | 'file' {
  if (entry.kind === 'directory') return 'folder';
  return /\.(md|markdown|mdown)$/i.test(entry.name) ? 'markdown' : 'file';
}

function Chevron({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg className={`file-tree-chevron${open ? ' open' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 4.2 10 8 6 11.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EntryIcon({ entry }: { entry: FileTreeEntry }): React.ReactElement {
  const kind = iconKind(entry);
  if (kind === 'folder') {
    return (
      <svg className="file-tree-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M1.8 4.2h4.1l1.3 1.4H14.2V13H1.8z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === 'markdown') return <span className="file-tree-icon markdown" aria-hidden="true">M</span>;
  return (
    <svg className="file-tree-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 1.8h5.2L12.4 5v9.2H4z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9.1 1.8V5.2h3.3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function TreeRow({ entry, depth, expanded, showPath, selected, onClick }: {
  entry: FileTreeEntry;
  depth: number;
  expanded: boolean;
  showPath: boolean;
  selected: boolean;
  onClick: () => void;
}): React.ReactElement {
  const directory = entry.kind === 'directory';
  const folder = parentPath(entry);
  return (
    <button
      type="button"
      className={`file-tree-row${depth === 0 ? ' file-tree-root' : ''}${selected ? ' selected' : ''}`}
      style={{ paddingLeft: 6 + depth * 14 }}
      role="treeitem"
      aria-expanded={directory ? expanded : undefined}
      aria-selected={directory ? undefined : selected}
      aria-label={directory ? entry.path || entry.name : entry.path}
      data-testid={entry.path ? `file-tree-${entry.path}` : 'file-tree-root'}
      onClick={onClick}
    >
      {directory ? <Chevron open={expanded} /> : <span className="file-tree-chevron spacer" />}
      <EntryIcon entry={entry} />
      <span className="file-tree-name">{entry.name}</span>
      {showPath && folder && <span className="file-tree-path">{folder}</span>}
    </button>
  );
}

export function FileTree({ projectId, projectName, loadEntries, onOpenFile, onOpenProject, selectedPath = null }: FileTreeProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [children, setChildren] = useState<Record<string, FileTreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [searchResults, setSearchResults] = useState<FileTreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searching = query.trim().length > 0;

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setError(null);
    void loadEntries('', '')
      .then((entries) => { if (!cancelled) setChildren((current) => ({ ...current, '': entries })); })
      .catch((failure) => { if (!cancelled) setError(failureMessage(failure)); });
    return () => { cancelled = true; };
  }, [projectId, loadEntries]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!projectId || !trimmed) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    setSearchResults(null);
    const timer = window.setTimeout(() => {
      void loadEntries('', trimmed)
        .then((entries) => { if (!cancelled) setSearchResults(entries); })
        .catch((failure) => {
          if (cancelled) return;
          setSearchResults([]);
          setError(failureMessage(failure));
        });
    }, 160);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [projectId, query, loadEntries]);

  const toggle = async (entryPath: string): Promise<void> => {
    const opening = !expanded.has(entryPath);
    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(entryPath);
      else next.delete(entryPath);
      return next;
    });
    if (!opening || children[entryPath]) return;
    try {
      const entries = await loadEntries(entryPath, '');
      setChildren((current) => ({ ...current, [entryPath]: entries }));
    } catch (failure) {
      setError(failureMessage(failure));
    }
  };

  const renderEntries = (parent: string, depth: number): React.ReactNode => {
    const items = children[parent];
    if (!items) return <p className="file-tree-note">Carregando arquivos…</p>;
    if (items.length === 0) return <p className="file-tree-note">Pasta vazia.</p>;
    return items.map((entry) => {
      const open = entry.kind === 'directory' && expanded.has(entry.path);
      return (
        <div key={entry.path} role="group">
          <TreeRow
            entry={entry}
            depth={depth}
            expanded={open}
            showPath={false}
            selected={entry.kind === 'file' && entry.path === selectedPath}
            onClick={() => { if (entry.kind === 'directory') void toggle(entry.path); else onOpenFile(entry.path); }}
          />
          {open && renderEntries(entry.path, depth + 1)}
        </div>
      );
    });
  };

  if (!projectId) {
    return (
      <div className="file-browser" data-testid="files-view">
        <div className="file-browser-empty">
          <p>Abra uma pasta para ver os arquivos do projeto.</p>
          {onOpenProject && <button className="btn-primary" type="button" onClick={onOpenProject}>Abrir projeto</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="file-browser" data-testid="files-view">
      <div className="file-browser-toolbar">
        <input data-testid="file-tree-filter" aria-label="Filtrar arquivos" placeholder="Filtrar arquivos" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {error && <p className="file-tree-error" role="alert">{error}</p>}
      <div className="file-tree-scroll">
        <div className="file-tree" role="tree" aria-label={`Arquivos de ${projectName}`}>
          <TreeRow entry={{ name: projectName, path: '', kind: 'directory' }} depth={0} expanded={expanded.has('')} showPath={false} selected={false} onClick={() => void toggle('')} />
          {searching ? (
            searchResults === null ? <p className="file-tree-note">Carregando arquivos…</p>
              : searchResults.length === 0 ? <p className="file-tree-note">Nenhum arquivo encontrado.</p>
                : searchResults.map((entry) => (
                  <TreeRow
                    key={entry.path}
                    entry={entry}
                    depth={1}
                    expanded={false}
                    showPath
                    selected={entry.kind === 'file' && entry.path === selectedPath}
                    onClick={() => { if (entry.kind === 'file') onOpenFile(entry.path); }}
                  />
                ))
          ) : expanded.has('') && renderEntries('', 1)}
        </div>
      </div>
    </div>
  );
}
