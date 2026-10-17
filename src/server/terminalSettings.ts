import fs from 'node:fs';
import type { TerminalEnvironment, TerminalSettings, TerminalShell } from '../types.js';
import { findExecutable } from './commandRunner.js';

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily: 'Menlo, Consolas, monospace', fontSize: 13, shell: 'system',
};

export function shellDefinitions(platform: string): Array<{ id: TerminalShell; label: string; binary: string }> {
  if (platform === 'win32') return [
    { id: 'cmd', label: 'CMD', binary: 'cmd.exe' },
    { id: 'powershell', label: 'Windows PowerShell', binary: 'powershell.exe' },
    { id: 'pwsh', label: 'PowerShell 7', binary: 'pwsh.exe' },
  ];
  return [
    ...(platform === 'darwin' ? [{ id: 'zsh' as const, label: 'Zsh', binary: 'zsh' }] : []),
    { id: 'bash', label: 'Bash', binary: 'bash' },
    { id: 'sh', label: 'Sh', binary: 'sh' },
  ];
}

function executablePath(binary: string): string | null {
  if (binary.includes('/') || binary.includes('\\')) {
    try { fs.accessSync(binary, fs.constants.X_OK); return fs.statSync(binary).isFile() ? binary : null; }
    catch { return null; }
  }
  const found = findExecutable(binary);
  if (found) return found;
  if (process.platform !== 'win32') return executablePath(`/bin/${binary}`);
  return null;
}

export function resolveTerminalShell(shell: TerminalShell): string[] {
  const definitions = shellDefinitions(process.platform);
  const binary = shell === 'system'
    ? process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
    : definitions.find((option) => option.id === shell)?.binary;
  if (!binary) throw new Error('Shell incompatível com este sistema operacional.');
  const executable = executablePath(binary);
  if (!executable) throw new Error(`Shell ${binary} não encontrado. Selecione outro terminal nas configurações.`);
  return [executable];
}

export function getTerminalEnvironment(): TerminalEnvironment {
  return {
    platform: process.platform,
    platformLabel: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
    shells: [
      { id: 'system', label: 'Padrão do sistema', available: true },
      ...shellDefinitions(process.platform).map(({ id, label, binary }) => ({ id, label, available: Boolean(executablePath(binary)) })),
    ],
  };
}

export function validateTerminalSettings(input: unknown): TerminalSettings {
  if (!input || typeof input !== 'object') throw new Error('Configurações de terminal inválidas.');
  const { fontFamily, fontSize, shell } = input as Partial<TerminalSettings>;
  if (typeof fontFamily !== 'string' || !fontFamily.trim() || fontFamily.length > 200 || /[\x00-\x1f]/.test(fontFamily)) throw new Error('Informe uma fonte válida (até 200 caracteres).');
  if (typeof fontSize !== 'number' || !Number.isInteger(fontSize) || fontSize < 8 || fontSize > 40) throw new Error('O tamanho da fonte deve ser um inteiro entre 8 e 40 px.');
  if (!shell || (shell !== 'system' && !shellDefinitions(process.platform).some((option) => option.id === shell))) throw new Error('Shell incompatível com este sistema operacional.');
  resolveTerminalShell(shell);
  return { fontFamily: fontFamily.trim(), fontSize, shell };
}
