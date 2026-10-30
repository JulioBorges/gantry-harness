import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEYS = ['HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;

/** Isola o Git de identidade e config globais/do sistema. O diretório vive até o processo sair. */
export function installIsolatedGitEnv(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-git-home-'));
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

/** Cópia do ambiente com chaves de identidade substituídas ou removidas. */
export function gitIdentityEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** HOME temporário para um teste, restaurando o ambiente anterior ao terminar. */
export function withIsolatedGitEnv(): () => void {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]])) as Partial<Record<(typeof KEYS)[number], string | undefined>>;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-git-home-'));
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  return () => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
  };
}
