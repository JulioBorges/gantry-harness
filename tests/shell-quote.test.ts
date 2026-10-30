import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { formatCommand, parsePosixCommand, quoteCmd, quotePosix, quotePowerShell, recoveryCommandLines } from '../src/shellQuote.js';

const samples = [
  'a b',
  "it's",
  'say "hi"',
  '100%',
  '%PATH%',
  'a^b',
  'a&b',
  'a`b',
  '$home',
  '-lead',
  'my file %PATH%',
] as const;

describe('shell quoting for recovery commands', () => {
  it('quotes each hostile character for POSIX, PowerShell and cmd', () => {
    expect(quotePosix('a b')).toBe("'a b'");
    expect(quotePosix("it's")).toBe(`'it'\\''s'`);
    expect(quotePosix('say "hi"')).toBe(`'say "hi"'`);
    expect(quotePosix('100%')).toBe("'100%'");
    expect(quotePosix('%PATH%')).toBe("'%PATH%'");
    expect(quotePosix('a^b')).toBe("'a^b'");
    expect(quotePosix('a&b')).toBe("'a&b'");
    expect(quotePosix('a`b')).toBe("'a`b'");
    expect(quotePosix('$home')).toBe("'$home'");
    expect(quotePosix('-lead')).toBe("'-lead'");

    expect(quotePowerShell('a b')).toBe("'a b'");
    expect(quotePowerShell("it's")).toBe("'it''s'");
    expect(quotePowerShell('say "hi"')).toBe(`'say "hi"'`);
    expect(quotePowerShell('100%')).toBe("'100%'");
    expect(quotePowerShell('%PATH%')).toBe("'%PATH%'");
    expect(quotePowerShell('a^b')).toBe("'a^b'");
    expect(quotePowerShell('a&b')).toBe("'a&b'");
    expect(quotePowerShell('a`b')).toBe("'a`b'");
    expect(quotePowerShell('$home')).toBe("'$home'");
    expect(quotePowerShell('-lead')).toBe("'-lead'");

    expect(quoteCmd('a b')).toBe('"a b"');
    expect(quoteCmd("it's")).toBe("it's");
    expect(quoteCmd('say "hi"')).toBe('^"say \\^"hi\\^"^"');
    expect(quoteCmd('100%')).toBe('100%');
    expect(quoteCmd('%PATH%')).toBe('^%PATH^%');
    expect(quoteCmd('%PATH%')).not.toContain('%PATH%');
    expect(quoteCmd('a^b')).toBe('"a^b"');
    expect(quoteCmd('a&b')).toBe('"a&b"');
    expect(quoteCmd('a`b')).toBe('a`b');
    expect(quoteCmd('$home')).toBe('$home');
    expect(quoteCmd('-lead')).toBe('"-lead"');
    expect(quoteCmd('my file %PATH%')).toBe('^"my file ^%PATH^%^"');
    expect(quoteCmd('my file %PATH%')).not.toContain('%PATH%');
  });

  it('round-trips POSIX quoting through the shell, including a leading dash', () => {
    const command = `python3 -c ${quotePosix('import json,sys; print(json.dumps(sys.argv[1:]))')} ${samples.map(quotePosix).join(' ')}`;
    const result = spawnSync('sh', ['-c', command], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([...samples]);
    expect(parsePosixCommand(samples.map(quotePosix).join(' '))).toEqual([...samples]);
  });

  it('parses the POSIX restore command the server already returns', () => {
    const hash = 'abc123def456abc123def456abc123def456abc1';
    const paths = ['notes file.txt', "it's", 'say "hi"', '100%', 'a^b', 'a&b', 'a`b', '$home', '-lead'];
    const command = `git restore --source ${quotePosix(`${hash}^3`)} --worktree -- ${paths.map(quotePosix).join(' ')}`;
    expect(parsePosixCommand(command)).toEqual(['git', 'restore', '--source', `${hash}^3`, '--worktree', '--', ...paths]);
    const lines = recoveryCommandLines('win32', parsePosixCommand(command)!);
    expect(lines.map(line => line.shell)).toEqual(['powershell', 'cmd']);
    expect(lines[0].command).toContain(`'${hash}^3'`);
    expect(lines[0].command).toContain("'-lead'");
    expect(lines[0].command).toContain("'it''s'");
    expect(lines[1].command).toContain('"-lead"');
    expect(lines[1].command).not.toContain('%PATH%');
    expect(formatCommand('posix', parsePosixCommand(command)!)).toBe(formatCommand('posix', ['git', 'restore', '--source', `${hash}^3`, '--worktree', '--', ...paths]));
  });

  it('shows one POSIX command outside Windows', () => {
    const lines = recoveryCommandLines('linux', ['git', 'stash', 'apply', '--index', 'abc']);
    expect(lines).toEqual([{ shell: 'posix', label: 'shell', command: formatCommand('posix', ['git', 'stash', 'apply', '--index', 'abc']) }]);
  });
});
