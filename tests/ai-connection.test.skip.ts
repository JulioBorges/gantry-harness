import { afterEach, describe, expect, it, vi } from 'vitest';
import { callProviderModel } from '../src/server/aiService.js';
import { runCommand } from '../src/server/commandRunner.js';

vi.mock('../src/server/commandRunner.js', () => ({ runCommand: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('real coordinator connections', () => {
  it('calls the selected CLI without a hidden enable flag and passes the model', async () => {
    vi.mocked(runCommand).mockResolvedValue({ exitCode: 0, stdout: 'Resposta do host', stderr: '' });
    const reply = await callProviderModel({
      prompt: 'Explique este projeto', repoRoot: '/tmp/project',
      settings: { mode: 'cli', activeProvider: 'cli', cliHarness: 'codex', providers: { cli: { model: 'chosen-model' } } },
    });
    expect(reply).toBe('Resposta do host');
    expect(runCommand).toHaveBeenCalledWith(
      expect.arrayContaining(['codex', 'exec', '--model', 'chosen-model']),
      expect.objectContaining({ cwd: '/tmp/project', input: 'Explique este projeto' }),
    );
  });

  it('reports a CLI failure instead of returning a canned assistant message', async () => {
    vi.mocked(runCommand).mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'authentication required' });
    await expect(callProviderModel({
      prompt: 'Pergunta', repoRoot: '/tmp/project',
      settings: { mode: 'cli', activeProvider: 'cli', cliHarness: 'codex' },
    })).rejects.toThrow(/codex.*authentication required/i);
  });

  it('requires an explicit CLI selection', async () => {
    await expect(callProviderModel({
      prompt: 'Pergunta', repoRoot: '/tmp/project', settings: { mode: 'cli', activeProvider: 'cli' },
    })).rejects.toThrow(/host/i);
  });

  it('reports missing API credentials without switching to a different backend', async () => {
    await expect(callProviderModel({
      prompt: 'Pergunta', repoRoot: '/tmp/project', settings: { mode: 'sdk', activeProvider: 'openai' },
    })).rejects.toThrow(/chave|key/i);
  });

  it('surfaces provider HTTP failures and redacts credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid secret-test-key', { status: 401 })));
    await expect(callProviderModel({
      prompt: 'Pergunta', repoRoot: '/tmp/project',
      settings: { mode: 'sdk', activeProvider: 'openai', providers: { openai: { apiKey: 'secret-test-key', model: 'chosen-model' } } },
    })).rejects.toThrow(/401/);
  });
});
