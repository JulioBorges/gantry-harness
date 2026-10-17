import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';

export interface FileArtifact {
  path: string;
  content: string;
  diff: string;
}

interface FileViewerDialogProps {
  artifact: FileArtifact;
  onClose: () => void;
  onSave: (content: string) => Promise<void>;
  onOpenFile?: (path: string) => Promise<void>;
  onLoadAsset?: (path: string, signal: AbortSignal) => Promise<Blob>;
  presentation?: 'dialog' | 'pane';
}

function PreviewImage({ src, alt, path, load }: { src?: string; alt?: string; path: string; load?: FileViewerDialogProps['onLoadAsset'] }): React.ReactElement {
  const remote = Boolean(src && /^(?:https?:|\/\/)/i.test(src));
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setUrl(null); setFailed(false);
    if (!src || remote || !load) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      try {
        const resolved = decodeURIComponent(new URL(src, `https://gantry.local/${path}`).pathname.slice(1));
        const blob = await load(resolved, controller.signal);
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch { if (!controller.signal.aborted) setFailed(true); }
    })();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, path, load, remote]);
  if (remote || url) return <img src={remote ? src : url!} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />;
  return <span className="markdown-image-status" role="img" aria-label={alt || 'Imagem'}>{failed || !load ? 'Imagem indisponível' : 'Carregando imagem…'}{alt ? ` · ${alt}` : ''}</span>;
}

export function FileViewerDialog({ artifact, onClose, onSave, onOpenFile, onLoadAsset, presentation = 'dialog' }: FileViewerDialogProps): React.ReactElement {
  const isMarkdown = /\.(md|markdown|mdown)$/i.test(artifact.path);
  const [view, setView] = useState<'preview' | 'source' | 'diff'>(isMarkdown ? 'preview' : 'source');
  const [draft, setDraft] = useState(artifact.content);
  const [savedContent, setSavedContent] = useState(artifact.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dirty = draft !== savedContent;
  const fileName = artifact.path.split('/').pop() || artifact.path;
  const heading = presentation === 'pane' ? fileName : 'Visualizar arquivo';

  useEffect(() => {
    if (presentation !== 'dialog') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    return () => {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      previousFocus?.focus();
    };
  }, [presentation]);

  const save = async () => {
    if (!dirty || saving) return;
    const content = draft;
    setSaving(true);
    setError(null);
    try { await onSave(content); setSavedContent(content); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível salvar. Tente novamente.'); }
    finally { setSaving(false); }
  };

  const viewer = (
    <>
      <header className="file-viewer-header">
        <div><h2 id="file-viewer-title">{heading}</h2><code title={artifact.path}>{artifact.path}</code></div>
        <button className="icon-button" autoFocus={presentation === 'dialog'} aria-label="Fechar visualização de arquivo" onClick={onClose}>×</button>
      </header>
      <div className="file-viewer-tabs" role="tablist" aria-label="Visualização do arquivo">
        {([
          ...(isMarkdown ? [['preview', 'Pré-visualização']] : []),
          ['source', 'Código'], ['diff', 'Diff'],
        ] as Array<[typeof view, string]>).map(([mode, title]) => <button key={mode} role="tab" id={`file-tab-${mode}`}
          aria-selected={view === mode} aria-controls="file-viewer-panel" tabIndex={view === mode ? 0 : -1}
          onClick={() => setView(mode)} onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const tabs = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
            const index = tabs.indexOf(event.currentTarget);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            tabs[next].focus(); tabs[next].click();
          }}>{title}</button>)}
      </div>
      {error && <p className="file-viewer-error" role="alert">{error}</p>}
      <div ref={panelRef} className="file-viewer-panel" id="file-viewer-panel" role="tabpanel" aria-labelledby={`file-tab-${view}`} tabIndex={0}>
        {view === 'preview' && <article className="markdown-preview" data-testid="markdown-preview">
          {draft.trim() ? <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSlug, { prefix: 'file-heading-' }]]} skipHtml components={{
            a: ({ node: _node, href, ...props }) => <a {...props} href={href} target={href?.startsWith('#') ? undefined : '_blank'} rel="noreferrer noopener" onClick={(event) => {
              if (href?.startsWith('#')) {
                event.preventDefault();
                try {
                  const id = decodeURIComponent(href.slice(1));
                  const target = document.getElementById(`file-heading-${id}`) ?? document.getElementById(id);
                  if (target && panelRef.current?.contains(target)) target.scrollIntoView?.({ block: 'start' });
                } catch { /* Invalid fragment leaves the current preview intact. */ }
                return;
              }
              if (!href || !onOpenFile || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(href)) return;
              event.preventDefault();
              setError(null);
              try {
                const path = decodeURIComponent(new URL(href, `https://gantry.local/${artifact.path}`).pathname.slice(1));
                void onOpenFile(path).catch((failure) => setError(failure instanceof Error ? failure.message : 'Não foi possível abrir o arquivo.'));
              } catch { setError('O link do arquivo é inválido.'); }
            }} />,
            img: ({ src, alt }) => <PreviewImage src={src} alt={alt} path={artifact.path} load={onLoadAsset} />,
          }}>{draft}</Markdown> : <p className="file-viewer-empty">Este arquivo Markdown está vazio.</p>}
        </article>}
        {view === 'source' && <textarea className="file-source-editor" aria-label={`Código de ${artifact.path}`} data-testid="artifact-editor" spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} />}
        {view === 'diff' && (artifact.diff ? <pre className="file-diff" aria-label="Alterações do arquivo">{artifact.diff.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : undefined}>{line}{'\n'}</span>)}</pre> : <p className="file-viewer-empty">Nenhuma alteração neste arquivo em relação ao Git.</p>)}
      </div>
      <footer className="file-viewer-footer"><span role="status">{saving ? 'Salvando…' : dirty ? 'Alterações não salvas' : `${draft.split('\n').length} linhas`}</span><button className={dirty ? 'btn-primary' : ''} data-testid="save-artifact-btn" disabled={!dirty || saving} onClick={() => void save()}>Salvar alterações</button></footer>
    </>
  );

  if (presentation === 'pane') {
    return <section className="file-viewer-pane" data-testid="file-viewer-pane" aria-labelledby="file-viewer-title">{viewer}</section>;
  }

  return (
    <dialog ref={dialogRef} className="file-viewer-dialog" aria-labelledby="file-viewer-title" aria-modal="true"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}>
      {viewer}
    </dialog>
  );
}
