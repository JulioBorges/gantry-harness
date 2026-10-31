import React from 'react';
import { parsePosixCommand, recoveryCommandLines } from '../shellQuote.js';

export function RecoveryCommands({ platform, argv, command }: {
  platform: string;
  argv?: string[];
  command?: string;
}): React.ReactElement {
  // Fora do Windows o texto POSIX já vem citado pelo servidor. Reformatá-lo
  // tiraria aspas de caminhos seguros e divergiria desse comando.
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
