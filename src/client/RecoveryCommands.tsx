import React from 'react';
import { parsePosixCommand, recoveryCommandLines } from '../shellQuote.js';

function RecoveryCommand({ platform, argv, command }: {
  platform: string;
  argv?: string[];
  command?: string;
}): React.ReactElement {
  // `command` is the server POSIX string (restore today, restoreTracked later).
  // Outside Windows it stays as received. Rebuilding it would drop quotes the server already chose.
  if (platform !== 'win32' && command && !argv) {
    return <span className="recovery-command" data-shell="posix" data-testid="recovery-command-posix"><code>{command}</code></span>;
  }
  const parsed = argv ?? (command ? parsePosixCommand(command) : null);
  if (!parsed) {
    return <>
      <code>{command}</code>
      {platform === 'win32' && <span className="recovery-command">Use Git Bash para colar este comando.</span>}
    </>;
  }
  const lines = recoveryCommandLines(platform, parsed);
  return <>
    {lines.map((line) => <span key={line.shell} className="recovery-command" data-shell={line.shell} data-testid={`recovery-command-${line.shell}`}>
      {lines.length > 1 ? `${line.label}: ` : null}<code>{line.command}</code>
    </span>)}
  </>;
}

export function RecoveryCommands({ platform, argv, command, restoreTracked }: {
  platform: string;
  argv?: string[];
  command?: string;
  restoreTracked?: string;
}): React.ReactElement {
  if (!argv && (command || restoreTracked)) {
    return <>
      {command ? <RecoveryCommand platform={platform} command={command} /> : null}
      {restoreTracked ? <RecoveryCommand platform={platform} command={restoreTracked} /> : null}
    </>;
  }
  return <RecoveryCommand platform={platform} argv={argv} command={command} />;
}
