import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GIT_FAILED_MESSAGE, GitError, withGitEnvironment } from '../src/server/git.js';
import { applyRepositorySetup, bootstrapProjectSkills } from '../src/server/projectInspector.js';
import { gitIdentityEnv, withIsolatedGitEnv } from './gitTestEnv.js';

describe('Gantry installation Git lifecycle', () => {
  let root: string;
  let repo: string;
  let home: string;
  let restoreEnv = () => {};
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

  beforeEach(() => {
    restoreEnv = withIsolatedGitEnv();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-setup-git-'));
    repo = path.join(root, 'repo');
    home = path.join(root, 'home');
    fs.mkdirSync(repo);
    git('init', '-b', 'main');
    git('config', 'user.name', 'Setup Test');
    git('config', 'user.email', 'setup@example.com');
    fs.writeFileSync(path.join(repo, 'README.md'), '# Project\n');
    git('add', 'README.md');
    git('commit', '-m', 'Initial commit');
    const pack = path.join(home, '.agents', 'skills', 'gantry');
    fs.mkdirSync(path.join(pack, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(pack, 'SKILL.md'), '# Gantry\n');
    fs.mkdirSync(path.join(pack, 'scripts', '__pycache__'));
    fs.writeFileSync(path.join(pack, 'scripts', '__pycache__', 'setup.pyc'), 'cache');
    // Exercise the actual script runner and Git lifecycle without an installed global pack.
    fs.writeFileSync(path.join(pack, 'scripts', 'setup.py'), `import json, pathlib, sys
root = pathlib.Path.cwd()
policy = json.loads(sys.argv[sys.argv.index('--config') + 1])
(root / '.gantry').mkdir(exist_ok=True)
(root / '.gantry/config.json').write_text(json.dumps(policy))
(root / 'AGENTS.md').write_text('<!-- gantry:begin -->\\nGantry policy\\n<!-- gantry:end -->\\n')
`);
  });

  afterEach(() => {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('commits installed skills and repository configuration so preflight sees a clean worktree', async () => {
    await bootstrapProjectSkills(repo, home);
    expect(git('status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(repo, '.agents/skills/gantry/scripts/__pycache__'))).toBe(false);
    expect(git('show', 'HEAD:.agents/skills/gantry/SKILL.md')).toBe('# Gantry');
    const result = await applyRepositorySetup(repo, { scope: 'repository', policy: { git: { target: 'main' } } }, path.join(root, 'profiles'));
    expect(result.applied).toBe(true);
    expect(git('status', '--porcelain')).toBe('');
    expect(JSON.parse(git('show', 'HEAD:.gantry/config.json')).git.target).toBe('main');
    expect(git('show', 'HEAD:AGENTS.md')).toContain('Gantry policy');
    const head = git('rev-parse', 'HEAD');
    await bootstrapProjectSkills(repo, home);
    await applyRepositorySetup(repo, { scope: 'repository', policy: { git: { target: 'main' } } }, path.join(root, 'profiles'));
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });

  it.each(['staged', 'unstaged', 'untracked'])('preserves %s operator changes and refuses installation before writing', async (state) => {
    const file = state === 'untracked' ? 'notes.txt' : 'README.md';
    fs.writeFileSync(path.join(repo, file), 'Operator work\n');
    if (state === 'staged') git('add', file);
    const status = git('status', '--porcelain');
    const head = git('rev-parse', 'HEAD');
    await expect(bootstrapProjectSkills(repo, home)).rejects.toThrow(/commit|stash/i);
    expect(fs.existsSync(path.join(repo, '.agents'))).toBe(false);
    expect(git('status', '--porcelain')).toBe(status);
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });

  it('refuses repository setup before changing files when operator work exists', async () => {
    await bootstrapProjectSkills(repo, home);
    fs.writeFileSync(path.join(repo, 'README.md'), 'Operator work\n');
    git('add', 'README.md');
    const head = git('rev-parse', 'HEAD');
    await expect(applyRepositorySetup(repo, { scope: 'repository', policy: {} }, path.join(root, 'profiles'))).rejects.toThrow(/commit|stash/i);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('diff', '--cached', '--name-only')).toBe('README.md');
    expect(fs.existsSync(path.join(repo, '.gantry/config.json'))).toBe(false);
  });

  it('reports a rejected installation commit instead of claiming success', async () => {
    const hook = path.join(repo, '.git/hooks/pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const head = git('rev-parse', 'HEAD');
    const error = await bootstrapProjectSkills(repo, home).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).code).toBe('git-failed');
    expect((error as Error).message).toMatch(/registrar a instalação/);
    expect((error as Error).message).toMatch(/hook/);
    expect((error as Error).message).toMatch(/log do servidor/);
    expect((error as Error).message).not.toMatch(/inacessível/);
    expect((error as Error).message).not.toContain(repo);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(fs.existsSync(path.join(repo, '.agents/skills/gantry/SKILL.md'))).toBe(true);
  });

  it('reports a missing author identity without calling the repository inaccessible', async () => {
    git('config', '--unset', 'user.name');
    git('config', '--unset', 'user.email');
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    try {
      const error = await withGitEnvironment(gitIdentityEnv({
        GIT_AUTHOR_NAME: undefined,
        GIT_AUTHOR_EMAIL: undefined,
        GIT_COMMITTER_NAME: undefined,
        GIT_COMMITTER_EMAIL: undefined,
      }), () => bootstrapProjectSkills(repo, home)).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).code).toBe('git-identity-unknown');
      expect((error as Error).message).toMatch(/user\.name e user\.email/);
      expect((error as Error).message).toMatch(/registrar a instalação/);
      expect((error as Error).message).toMatch(/ausente\. Revise/);
      expect((error as Error).message).not.toMatch(/\.\./);
      expect((error as Error).message).not.toMatch(/inacessível|Author identity unknown/);
      expect((error as Error).message).not.toContain(repo);
      expect(logged.join('\n')).toMatch(/Author identity unknown/);
      expect(fs.existsSync(path.join(repo, '.agents'))).toBe(false);
    } finally { logSpy.mockRestore(); }
  });

  it('reports a missing committer identity before writing installation files', async () => {
    git('config', '--unset', 'user.name');
    git('config', '--unset', 'user.email');
    fs.writeFileSync(path.join(process.env.HOME ?? '', '.gitconfig'), '[user]\n\tname = Global Operator\n\temail = global@example.test\n');
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    try {
      const error = await withGitEnvironment(gitIdentityEnv({
        GIT_AUTHOR_NAME: 'Author Only',
        GIT_AUTHOR_EMAIL: 'author@example.test',
        GIT_COMMITTER_NAME: undefined,
        GIT_COMMITTER_EMAIL: undefined,
      }), () => bootstrapProjectSkills(repo, home)).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).code).toBe('git-identity-unknown');
      expect((error as Error).message).toMatch(/user\.name e user\.email/);
      expect((error as Error).message).toMatch(/ausente\. Revise/);
      expect((error as Error).message).toMatch(/identidade do committer/);
      expect((error as Error).message).not.toMatch(/identidade do autor/);
      expect((error as Error).message).not.toMatch(/\.\./);
      expect((error as Error).message).not.toMatch(/Committer identity unknown|auto-detect|inacessível/);
      expect((error as Error).message).not.toContain(repo);
      expect(logged.join('\n')).toMatch(/Committer identity unknown/);
      expect(fs.existsSync(path.join(repo, '.agents'))).toBe(false);
    } finally { logSpy.mockRestore(); }
  });

  it('does not copy check-ignore stderr when the ignore check fails', async () => {
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const wrapper = path.join(bin, 'git');
    fs.writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = check-ignore ]; then echo 'leak /secret/ignore-path' >&2; exit 2; fi\nexec ${JSON.stringify(realGit)} "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    try {
      const error = await withGitEnvironment({ ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }, () => bootstrapProjectSkills(repo, home)).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).code).toBe('git-failed');
      expect((error as Error).message).toBe(GIT_FAILED_MESSAGE);
      expect((error as Error).message).not.toMatch(/leak|secret|ignore-path/);
      expect(logged.join('\n')).toMatch(/leak \/secret\/ignore-path/);
      expect(fs.existsSync(path.join(repo, '.agents'))).toBe(false);
    } finally { logSpy.mockRestore(); }
  });

  it('refuses ignored skills before installing files that cannot be committed', async () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), '.agents/\n');
    git('add', '.gitignore');
    git('commit', '-m', 'Ignore local agents');
    await expect(bootstrapProjectSkills(repo, home)).rejects.toThrow(/ignoradas pelo Git/);
    expect(fs.existsSync(path.join(repo, '.agents'))).toBe(false);
    expect(git('status', '--porcelain')).toBe('');
  });
});
