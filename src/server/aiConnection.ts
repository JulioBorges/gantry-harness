import fs from 'node:fs';
import path from 'node:path';
import { findExecutable } from './commandRunner.js';
import type { ExecutionSettings, ProviderSettingsInput, RegisteredProject } from '../types.js';

export interface CoordinatorConnection {
  mode: 'cli' | 'sdk';
  host: string;
  model: string | null;
  source: 'profile' | 'repository' | 'global';
  ready: boolean;
  detail: string;
}

function readExecution(filename: string): ExecutionSettings {
  if (!fs.existsSync(filename)) return {};
  const data = JSON.parse(fs.readFileSync(filename, 'utf-8'));
  return data.execution ?? data;
}

export function resolveCoordinatorConnection(
  saved: ProviderSettingsInput,
  project: RegisteredProject | undefined,
  profileRoot: string,
): { settings: ProviderSettingsInput; connection: CoordinatorConnection } {
  const settings = structuredClone(saved);
  let source: CoordinatorConnection['source'] = 'global';
  if (settings.mode === 'cli' && project) {
    const profilePath = path.join(profileRoot, project.unitId, 'execution.json');
    try {
      const repository = readExecution(path.join(project.path, '.gantry', 'config.json'));
      const profile = readExecution(profilePath);
      const host = profile.hostHarness ?? repository.hostHarness;
      if (host) {
        source = profile.hostHarness ? 'profile' : 'repository';
        const aliases: Record<string, ProviderSettingsInput['cliHarness']> = {
          'claude-code': 'claude', claude: 'claude', codex: 'codex', opencode: 'opencode', antigravity: 'agy', agy: 'agy',
        };
        if (!aliases[host]) throw new Error(`Host salvo no projeto não suportado: ${host}. Revise a configuração do projeto.`);
        settings.cliHarness = aliases[host];
        settings.activeProvider = 'cli';
        if (saved.cliHarness !== settings.cliHarness && settings.providers?.cli) {
          delete settings.providers.cli.model;
        }
      }
    } catch (error) {
      return { settings, connection: {
        mode: 'cli', host: 'configuração inválida', model: null,
        source: fs.existsSync(profilePath) ? 'profile' : 'repository', ready: false,
        detail: `Revise o host salvo no projeto ou perfil: ${(error as Error).message}`,
      } };
    }
  }
  const host = settings.mode === 'cli' ? settings.cliHarness ?? '' : settings.activeProvider;
  const config = settings.providers?.[settings.mode === 'cli' ? 'cli' : settings.activeProvider];
  const ready = settings.mode === 'cli'
    ? Boolean(host && host !== 'agy' && findExecutable(host))
    : Boolean(host !== 'cli' && config?.apiKey?.trim() && config.model?.trim());
  const detail = ready
    ? (settings.mode === 'cli' ? 'CLI encontrado. A autenticação será verificada ao enviar sua mensagem.' : 'API configurada. A conexão será verificada ao enviar sua mensagem.')
    : settings.mode === 'cli'
      ? host === 'agy' ? 'Use o terminal do Antigravity ou configure uma API para conversar.' : host ? `${host} não encontrado no PATH do servidor. Instale e autentique o host salvo.` : 'Selecione um host para começar.'
      : 'Informe provedor, modelo e chave de API nas Configurações de IA.';
  return { settings, connection: { mode: settings.mode, host, model: config?.model ?? null, source, ready, detail } };
}
