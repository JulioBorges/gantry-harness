import React, { useEffect, useState } from 'react';

type FontWindow = Window & { queryLocalFonts?: () => Promise<Array<{ family: string }>> };
const fontValue = (family: string) => `${JSON.stringify(family)}, monospace`;

export function SystemFontSelect({ value, onChange }: { value: string; onChange: (value: string) => void }): React.ReactElement {
  const [families, setFamilies] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const supported = typeof (window as FontWindow).queryLocalFonts === 'function';

  useEffect(() => {
    let cancelled = false;
    const fontWindow = window as FontWindow;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        if (!fontWindow.queryLocalFonts) throw new Error('Este navegador não permite listar fontes locais. Abra o app desktop para selecionar as fontes instaladas.');
        const fonts = await fontWindow.queryLocalFonts();
        if (cancelled) return;
        const names = [...new Set(fonts.map((font) => font.family.trim()).filter(Boolean))]
          .sort((a, b) => a.localeCompare(b));
        setFamilies(names);
        if (!names.length) setError('Nenhuma fonte foi retornada. Se estiver no navegador, verifique a permissão de acesso às fontes e tente novamente.');
      } catch (failure) {
        if (cancelled) return;
        const problem = failure instanceof Error || failure instanceof DOMException ? failure : new Error('Não foi possível listar as fontes do sistema.');
        const denied = ['NotAllowedError', 'SecurityError'].includes(problem.name);
        setError(denied
          ? 'O acesso às fontes não foi autorizado. Permita o acesso nas configurações do navegador e tente novamente.'
          : problem.name === 'InvalidStateError'
            ? 'Clique em Carregar fontes do sistema para autorizar a leitura das fontes.'
            : problem.message);
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [attempt]);

  const selectedFamily = families.find((family) => value === fontValue(family) || value === family || value.startsWith(`${family},`));
  return <>
    <label htmlFor="terminal-font">Fonte do terminal</label>
    <select id="terminal-font" value={value} disabled={loading} aria-busy={loading} aria-describedby="terminal-font-help" onChange={(event) => onChange(event.target.value)}>
      <option value="monospace">Padrão monoespaçado</option>
      {value !== 'monospace' && !selectedFamily && <option value={value}>Configuração salva{families.length ? ' (fora da lista)' : ''}</option>}
      {families.map((family) => <option key={family} value={family === selectedFamily ? value : fontValue(family)} style={{ fontFamily: fontValue(family) }}>{family}</option>)}
    </select>
    <p id="terminal-font-help" className="field-help" aria-live="polite">{loading ? 'Carregando fontes instaladas…' : error || `${families.length} famílias de fontes instaladas neste dispositivo. Selecione uma fonte para ver a prévia abaixo.`}</p>
    {supported && <button className="font-reload-button" type="button" disabled={loading} onClick={() => setAttempt((current) => current + 1)}>{error ? 'Carregar fontes do sistema' : 'Atualizar lista de fontes'}</button>}
  </>;
}
