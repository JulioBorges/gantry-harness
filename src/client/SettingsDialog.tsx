import React, { useEffect, useRef } from 'react';

export type SettingsTab = 'terminal' | 'project' | 'remote';
const TABS: Array<[SettingsTab, string]> = [['terminal', 'Terminal'], ['project', 'Projeto'], ['remote', 'Acesso remoto']];

export function SettingsDialog({ tab, onTabChange, onClose, children }: {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onClose: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    dialog.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      previousFocus?.focus();
    };
  }, []);

  return <dialog ref={dialogRef} className="settings-dialog" aria-modal="true" aria-labelledby="settings-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header className="settings-dialog-header"><h2 id="settings-title">Configurações</h2><button className="icon-button" aria-label="Fechar configurações" onClick={onClose}>×</button></header>
    <div className="settings-tabs" role="tablist" aria-label="Categorias de configuração">
      {TABS.map(([id, label]) => <button key={id} id={`settings-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="settings-content" tabIndex={tab === id ? 0 : -1}
        onClick={() => onTabChange(id)} onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = TABS.findIndex(([value]) => value === id);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
          onTabChange(TABS[next][0]);
          document.getElementById(`settings-tab-${TABS[next][0]}`)?.focus();
        }}>{label}</button>)}
    </div>
    <div className="settings-dialog-content" id="settings-content" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} tabIndex={0}>{children}</div>
  </dialog>;
}
