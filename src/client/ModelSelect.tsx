import React from 'react';

export const EXECUTION_HOSTS = [
  { id: 'opencode', label: 'OpenCode' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'antigravity', label: 'Antigravity' },
] as const;

const DISCOVERY_HARNESS: Record<string, string> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  agy: 'antigravity',
  antigravity: 'antigravity',
  codex: 'codex',
  opencode: 'opencode',
};

export interface CatalogModel {
  id: string;
  name?: string;
  supportedEfforts?: string[];
}

export function discoveryHarness(host: string): string {
  return DISCOVERY_HARNESS[host] ?? host;
}

export function modelOptionLabel(model: CatalogModel): string {
  return model.name && model.name !== model.id ? `${model.id} — ${model.name}` : model.id;
}

export function ModelSelect({
  id,
  label,
  ariaLabel,
  harnessLabel,
  models,
  value,
  loading,
  error,
  allowEmpty = false,
  emptyLabel = 'Selecione um modelo',
  showStatus = true,
  onChange,
}: {
  id?: string;
  label: string;
  ariaLabel: string;
  harnessLabel: string;
  models: CatalogModel[];
  value: string;
  loading: boolean;
  error?: string;
  allowEmpty?: boolean;
  emptyLabel?: string;
  showStatus?: boolean;
  onChange: (modelId: string) => void;
}): React.ReactElement {
  const known = models.some((model) => model.id === value);
  return (
    <label>
      {label}
      <select id={id} aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{allowEmpty ? emptyLabel : 'Selecione um modelo'}</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>{modelOptionLabel(model)}</option>
        ))}
        {value && !known && <option value={value}>{`${value} (incompatível com ${harnessLabel})`}</option>}
      </select>
      {showStatus && loading && models.length === 0 && <p className="field-help">Carregando modelos de {harnessLabel}…</p>}
      {showStatus && !loading && !error && models.length === 0 && <p className="field-help">Nenhum modelo disponível em {harnessLabel}.</p>}
      {showStatus && error && <p className="field-help" role="alert">{error}</p>}
    </label>
  );
}
