import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    expect(lines).toEqual([{ shell: 'posix', label: 'shell', command: 'git stash apply --index abc' }]);
  });

  it('quotes a POSIX token only when the shell would expand it', () => {
    const hash = 'abc123def456abc123def456abc123def456abc1';
    expect(formatCommand('posix', ['git', 'stash', 'apply', '--index', hash])).toBe(`git stash apply --index ${hash}`);
    expect(formatCommand('posix', ['git', 'restore', '--source', `${hash}^3`, '--worktree', '--', 'a b', "it's", '-lead'])).toBe(
      `git restore --source '${hash}^3' --worktree -- 'a b' 'it'\\''s' -lead`,
    );
  });

  it('starts a PowerShell command with the bare git executable or the call operator', () => {
    const hash = 'abc123def456abc123def456abc123def456abc1';
    expect(formatCommand('powershell', ['git', 'stash', 'apply', '--index', hash])).toBe(`git 'stash' 'apply' '--index' '${hash}'`);
    expect(formatCommand('powershell', ['/opt/git bin/git', 'status'])).toBe(`& '/opt/git bin/git' 'status'`);
    expect(formatCommand('cmd', ['git', 'stash', 'apply', '--index', hash, 'a b', "it's"])).toBe(`git stash apply "--index" ${hash} "a b" it's`);
  });

  const pwsh = spawnSync('sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' });
  const pwshBin = pwsh.status === 0 ? pwsh.stdout.trim() : '';

  it.skipIf(!pwshBin)('runs the generated PowerShell command in pwsh when it is installed', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-pwsh-stash-'));
    const file = path.join(repo, 'README.md');
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Pwsh stash'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'pwsh-stash@example.test'], { cwd: repo });
    fs.writeFileSync(file, 'base\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    fs.writeFileSync(file, 'changed\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['stash', 'push', '--message', 'pwsh-apply'], { cwd: repo });
    const hash = execFileSync('git', ['rev-parse', 'refs/stash'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(fs.readFileSync(file, 'utf8')).toBe('base\n');
    const stash = formatCommand('powershell', ['git', 'stash', 'apply', '--index', hash]);
    const version = spawnSync(pwshBin, ['-NoProfile', '-NonInteractive', '-Command', formatCommand('powershell', ['git', '--version'])], { encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(version.stdout).toMatch(/git version/);
    const applied = spawnSync(pwshBin, ['-NoProfile', '-NonInteractive', '-Command', stash], { cwd: repo, encoding: 'utf8' });
    expect(applied.status, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    expect(`${applied.stdout}\n${applied.stderr}`).not.toMatch(/ParserError/);
    expect(fs.readFileSync(file, 'utf8')).toBe('changed\n');
    expect(execFileSync('git', ['diff', '--cached', '--', 'README.md'], { cwd: repo, encoding: 'utf8' })).toContain('+changed');

    const python = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-pwsh-'));
    const spaced = path.join(directory, 'py bin');
    fs.symlinkSync(python, spaced);
    const code = 'import json,sys; print(json.dumps(sys.argv[1:]))';
    const command = formatCommand('powershell', [spaced, '-c', code, ...samples]);
    expect(command.startsWith('& ')).toBe(true);
    const echoed = spawnSync(pwshBin, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
    expect(echoed.status, echoed.stderr).toBe(0);
    expect(JSON.parse(echoed.stdout)).toEqual([...samples]);
  });
});
