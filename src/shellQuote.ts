/**
 * Cita um argv para o operador colar no shell.
 * O cmd segue a regra do winbox-args: aspas duplas para espaço e metacaracteres
 * que as aspas neutralizam, e caret quando há aspas internas ou expansão %nome%.
 */

export type RecoveryShell = 'posix' | 'cmd' | 'powershell';

export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function quoteCmd(value: string, module = false): string {
  let quote = /[ \t]/.test(value) || value.length === 0 || value.startsWith('-');
  let doubleQuotes = 0;
  let escaped = value.replace(/(\\*)"/g, (_match, slashes: string) => {
    doubleQuotes += 1;
    return `${slashes}${slashes}\\"`;
  });
  let meta = doubleQuotes > 0 || /%[^%]+%/.test(escaped);
  if (!meta) quote = quote || /[\^&|<>()]/.test(escaped);
  else if (module && doubleQuotes === 0 && quote) meta = false;
  if (quote) escaped = `"${escaped.replace(/(\\*)$/, (_match, slashes: string) => `${slashes}${slashes}`)}"`;
  if (meta) escaped = escaped.replace(/(["^&|<>()%])/g, '^$1');
  return escaped;
}

export function quoteArg(shell: RecoveryShell, value: string, module = false): string {
  if (shell === 'posix') return quotePosix(value);
  if (shell === 'powershell') return quotePowerShell(value);
  return quoteCmd(value, module);
}

export function formatCommand(shell: RecoveryShell, argv: string[]): string {
  return argv.map((arg, index) => quoteArg(shell, arg, shell === 'cmd' && index === 0)).join(' ');
}

export interface RecoveryCommandLine {
  shell: RecoveryShell;
  label: string;
  command: string;
}

export function recoveryCommandLines(platform: string, argv: string[]): RecoveryCommandLine[] {
  if (platform === 'win32') {
    return [
      { shell: 'powershell', label: 'PowerShell', command: formatCommand('powershell', argv) },
      { shell: 'cmd', label: 'cmd', command: formatCommand('cmd', argv) },
    ];
  }
  return [{ shell: 'posix', label: 'shell', command: formatCommand('posix', argv) }];
}

/** Lê um comando citado só com aspas simples POSIX, como o restore da limpeza. */
export function parsePosixCommand(command: string): string[] | null {
  const args: string[] = [];
  let index = 0;
  let current = '';
  let inArg = false;
  const push = () => {
    if (!inArg) return;
    args.push(current);
    current = '';
    inArg = false;
  };
  while (index < command.length) {
    const char = command[index];
    if (!inArg && (char === ' ' || char === '\t')) {
      index += 1;
      continue;
    }
    if (char === "'") {
      inArg = true;
      index += 1;
      let closed = false;
      while (index < command.length) {
        if (command[index] !== "'") {
          current += command[index];
          index += 1;
          continue;
        }
        if (command[index + 1] === '\\' && command[index + 2] === "'" && command[index + 3] === "'") {
          current += "'";
          index += 4;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      if (!closed) return null;
      continue;
    }
    if (char === ' ' || char === '\t') {
      push();
      index += 1;
      continue;
    }
    inArg = true;
    current += char;
    index += 1;
  }
  push();
  return command.trim() && args.length === 0 ? null : args;
}
