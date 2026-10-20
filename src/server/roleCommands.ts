import fs from 'node:fs';
import path from 'node:path';
import type { RoleCommand, RegisteredProject } from '../types.js';

export const EXECUTION_ROLES = ['plan', 'implement', 'review', 'critic'] as const;

export function commandRoles(value: unknown): Record<string, RoleCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Informe os comandos por papel.');
  const roles: Record<string, RoleCommand> = {};
  for (const role of EXECUTION_ROLES) {
    const selection = (value as Record<string, unknown>)[role] as { command?: unknown } | undefined;
    if (selection?.command !== undefined && typeof selection.command !== 'string') throw new Error(`O comando de ${role} deve ser um caminho de executável.`);
    if (typeof selection?.command === 'string' && selection.command.trim()) roles[role] = { command: selection.command.trim() };
  }
  return roles;
}

interface CommandConfig {
  execution?: { roles?: unknown };
  roles?: unknown;
  [key: string]: unknown;
}

function readJson(file: string): CommandConfig {
  if (!fs.existsSync(file)) return {};
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Configuração inválida em ${file}.`);
  return value as CommandConfig;
}

export function projectCommandRoles(project: RegisteredProject, profileRoot: string): Record<string, RoleCommand> {
  return {
    ...commandRoles(readJson(path.join(project.path, '.gantry', 'config.json')).execution?.roles ?? {}),
    ...commandRoles(readJson(path.join(profileRoot, project.unitId, 'execution.json')).roles ?? {}),
  };
}

export function saveProjectCommands(project: RegisteredProject, profileRoot: string, input: unknown): void {
  const file = path.join(profileRoot, project.unitId, 'execution.json');
  const profile = readJson(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...profile, roles: commandRoles(input) }, null, 2) + '\n');
}

export function effectiveCommandRoles(project: RegisteredProject, profileRoot: string, global: unknown): Record<string, RoleCommand> {
  return Object.fromEntries(Object.entries({ ...commandRoles(global ?? {}), ...projectCommandRoles(project, profileRoot) })
    .map(([role, selection]) => [role, { command: path.resolve(project.path, selection.command) }]));
}

export function missingCommand(roles: Record<string, RoleCommand>, kind: string): string | undefined {
  return (kind === 'plan' ? EXECUTION_ROLES : EXECUTION_ROLES.slice(1)).find((role) => {
    try {
      const file = roles[role]?.command;
      if (!file || !fs.statSync(file).isFile()) return true;
      fs.accessSync(file, fs.constants.X_OK);
      return false;
    } catch { return true; }
  });
}

// The pack reads repository policy only. Overlay machine-local commands in its
// Python process, without rewriting its pin, the repository or the worktree.
// All execution, gates and role spawning remain owned by cli.py.
export function withRoleCommands(command: string[], roles: Record<string, RoleCommand>): string[] {
  const cli = command[1];
  if (!cli?.endsWith('cli.py') || !fs.existsSync(path.join(path.dirname(cli), 'common.py'))) return command;
  const bootstrap = `import sys,json,runpy
from pathlib import Path
cli=sys.argv[1]
roles=json.loads(sys.argv[2])
sys.path.insert(0,str(Path(cli).parent))
import common
original=common.resolve_policy
def policy(root=None):
    value=original(root)
    value.setdefault('execution',{}).setdefault('roles',{}).update(roles)
    return value
common.resolve_policy=policy
sys.argv=[cli]+sys.argv[3:]
runpy.run_path(cli,run_name='__main__')`;
  return [command[0], '-B', '-c', bootstrap, cli, JSON.stringify(roles), ...command.slice(2)];
}
