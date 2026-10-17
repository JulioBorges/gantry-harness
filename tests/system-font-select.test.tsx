// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SystemFontSelect } from '../src/client/SystemFontSelect.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('lists real font families alphabetically without duplicate styles and returns the selected CSS font', async () => {
  const query = vi.fn(async () => [{ family: 'Menlo' }, { family: 'Arial' }, { family: 'Menlo' }, { family: ' Fira Code ' }]);
  vi.stubGlobal('queryLocalFonts', query);
  const onChange = vi.fn();
  render(<SystemFontSelect value="Menlo, Consolas, monospace" onChange={onChange} />);
  await screen.findByRole('option', { name: 'Fira Code' });
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Padrão monoespaçado', 'Arial', 'Fira Code', 'Menlo']);
  expect((screen.getByLabelText('Fonte do terminal') as HTMLSelectElement).value).toBe('Menlo, Consolas, monospace');
  expect(screen.getByText(/3 famílias de fontes instaladas/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Fonte do terminal'), { target: { value: '"Fira Code", monospace' } });
  expect(onChange).toHaveBeenCalledWith('"Fira Code", monospace');
  expect(query).toHaveBeenCalledTimes(1);
});

it('preserves a saved unavailable font without presenting it as installed and can refresh newly installed fonts', async () => {
  const query = vi.fn().mockResolvedValueOnce([{ family: 'Arial' }]).mockResolvedValueOnce([{ family: 'Arial' }, { family: 'New Mono' }]);
  vi.stubGlobal('queryLocalFonts', query);
  render(<SystemFontSelect value='"New Mono", monospace' onChange={vi.fn()} />);
  await screen.findByRole('option', { name: 'Arial' });
  expect(screen.getByRole('option', { name: 'Configuração salva (fora da lista)' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar lista de fontes' }));
  await screen.findByRole('option', { name: 'New Mono' });
  expect(screen.queryByRole('option', { name: /Configuração salva/ })).toBeNull();
  expect((screen.getByLabelText('Fonte do terminal') as HTMLSelectElement).value).toBe('"New Mono", monospace');
});

it('reports denied access and retries on an explicit click without losing the saved choice', async () => {
  const query = vi.fn().mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError')).mockResolvedValueOnce([{ family: 'Menlo' }]);
  vi.stubGlobal('queryLocalFonts', query);
  render(<SystemFontSelect value="monospace" onChange={vi.fn()} />);
  await screen.findByText(/O acesso às fontes não foi autorizado/);
  fireEvent.click(screen.getByRole('button', { name: 'Carregar fontes do sistema' }));
  await screen.findByRole('option', { name: 'Menlo' });
  expect((screen.getByLabelText('Fonte do terminal') as HTMLSelectElement).value).toBe('monospace');
  expect(query).toHaveBeenCalledTimes(2);
});

it('shows an actionable message on unsupported browsers and never invents installed fonts', async () => {
  vi.stubGlobal('queryLocalFonts', undefined);
  render(<SystemFontSelect value="monospace" onChange={vi.fn()} />);
  await screen.findByText(/Este navegador não permite listar fontes locais/);
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Padrão monoespaçado']);
  expect(screen.queryByRole('button')).toBeNull();
  await waitFor(() => expect((screen.getByLabelText('Fonte do terminal') as HTMLSelectElement).disabled).toBe(false));
});


it('explains empty font results, including browsers that return an empty list for denied access', async () => {
  vi.stubGlobal('queryLocalFonts', vi.fn(async () => []));
  render(<SystemFontSelect value="monospace" onChange={vi.fn()} />);
  await screen.findByText(/Nenhuma fonte foi retornada.*verifique a permissão/);
  expect(screen.getByRole('button', { name: 'Carregar fontes do sistema' })).toBeTruthy();
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Padrão monoespaçado']);
});
