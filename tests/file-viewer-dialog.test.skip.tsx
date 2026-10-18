// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileViewerDialog } from '../src/client/FileViewerDialog.js';

afterEach(cleanup);
const markdown = '# Guia do projeto\n\nTexto com **destaque** e `código`.\n\n| Etapa | Estado |\n| --- | --- |\n| Planejar | Pronto |\n\n- [x] Revisar\n\n```ts\nconst ready = true;\n```\n';

it('renders an inline pane without a modal when presentation is pane', () => {
  const close = vi.fn();
  render(<FileViewerDialog presentation="pane" artifact={{ path: 'src/app.ts', content: 'const n = 1;\n', diff: '' }} onClose={close} onSave={vi.fn()} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('region', { name: 'app.ts' })).toBeTruthy();
  expect((screen.getByTestId('artifact-editor') as HTMLTextAreaElement).value).toBe('const n = 1;\n');
  fireEvent.click(screen.getByRole('button', { name: 'Fechar visualização de arquivo' }));
  expect(close).toHaveBeenCalledOnce();
});

it('opens Markdown in an accessible modal with rendered headings, tables, checklists and code', () => {
  render(<FileViewerDialog artifact={{ path: 'docs/README.MD', content: markdown, diff: '' }} onClose={vi.fn()} onSave={vi.fn()} />);
  expect(screen.getByRole('dialog', { name: 'Visualizar arquivo' }).getAttribute('aria-modal')).toBe('true');
  expect(screen.getByRole('heading', { name: 'Guia do projeto' })).toBeTruthy();
  expect(screen.getByRole('table').textContent).toContain('Planejar');
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText('const ready = true;')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Pré-visualização' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByTestId('artifact-editor')).toBeNull();
});

it('preserves edits across preview/source/diff, saves explicitly, and keeps errors inside the dialog', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('Não foi possível gravar o arquivo.')).mockResolvedValueOnce(undefined);
  render(<FileViewerDialog artifact={{ path: 'guide.md', content: '# Original', diff: '+new line' }} onClose={vi.fn()} onSave={save} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Código' }));
  fireEvent.change(screen.getByTestId('artifact-editor'), { target: { value: '# Alterado' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Pré-visualização' }));
  expect(screen.getByRole('heading', { name: 'Alterado' })).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));
  expect(screen.getByLabelText('Alterações do arquivo').textContent).toContain('+new line');
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('save-artifact-btn'));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('Não foi possível gravar');
  fireEvent.click(screen.getByTestId('save-artifact-btn'));
  await waitFor(() => expect((screen.getByTestId('save-artifact-btn') as HTMLButtonElement).disabled).toBe(true));
  expect(save).toHaveBeenLastCalledWith('# Alterado');
});

it('shows other file types as source, allows keyboard tab navigation, and closes on Escape cancellation', () => {
  const close = vi.fn();
  render(<FileViewerDialog artifact={{ path: 'src/app.ts', content: '<script>code</script>', diff: '' }} onClose={close} onSave={vi.fn()} />);
  expect((screen.getByTestId('artifact-editor') as HTMLTextAreaElement).value).toBe('<script>code</script>');
  expect(screen.queryByRole('tab', { name: 'Pré-visualização' })).toBeNull();
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Código' }), { key: 'ArrowRight' });
  expect(screen.getByText('Nenhuma alteração neste arquivo em relação ao Git.')).toBeTruthy();
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
});

it('does not turn Markdown HTML or script URLs into executable content', () => {
  const { container } = render(<FileViewerDialog artifact={{ path: 'untrusted.md', content: '# Documento\n\n<script>alert(1)</script>\n\n[link](javascript:alert%281%29)\n\n<img src=x onerror=alert(1)>', diff: '' }} onClose={vi.fn()} onSave={vi.fn()} />);
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('[onerror]')).toBeNull();
  expect(container.querySelector('a')?.getAttribute('href') || '').not.toMatch(/^javascript:/);
});

it('opens relative Markdown file links in the viewer and reports missing files in place', async () => {
  const open = vi.fn().mockRejectedValue(new Error('Arquivo não encontrado.'));
  render(<FileViewerDialog artifact={{ path: 'docs/guide.md', content: '[Outro documento](../README.md)', diff: '' }} onClose={vi.fn()} onSave={vi.fn()} onOpenFile={open} />);
  fireEvent.click(screen.getByRole('link', { name: 'Outro documento' }));
  expect(open).toHaveBeenCalledWith('README.md');
  expect((await screen.findByRole('alert')).textContent).toContain('Arquivo não encontrado');
});

it('resolves repository images relative to the Markdown file and releases their object URLs', async () => {
  const revoke = vi.fn();
  const NativeURL = URL;
  vi.stubGlobal('URL', class extends NativeURL {
    static createObjectURL = vi.fn(() => 'blob:file-preview');
    static revokeObjectURL = revoke;
  });
  const load = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
  try {
    const view = render(<FileViewerDialog artifact={{ path: 'docs/guide.md', content: '![Diagrama](./images/flow.png)', diff: '' }} onClose={vi.fn()} onSave={vi.fn()} onLoadAsset={load} />);
    await waitFor(() => expect(screen.getByRole('img', { name: 'Diagrama' }).getAttribute('src')).toBe('blob:file-preview'));
    expect(load).toHaveBeenCalledWith('docs/images/flow.png', expect.any(AbortSignal));
    view.unmount();
    expect(revoke).toHaveBeenCalledWith('blob:file-preview');
  } finally { vi.unstubAllGlobals(); }
});

it('navigates a Markdown table of contents within the dialog', () => {
  render(<FileViewerDialog artifact={{ path: 'README.md', content: '[Instalação](#instalação)\n\n## Instalação', diff: '' }} onClose={vi.fn()} onSave={vi.fn()} />);
  const heading = screen.getByRole('heading', { name: 'Instalação' });
  const scroll = vi.fn();
  heading.scrollIntoView = scroll;
  expect(heading.id).toBe('file-heading-instalação');
  fireEvent.click(screen.getByRole('link', { name: 'Instalação' }));
  expect(scroll).toHaveBeenCalledOnce();
});
