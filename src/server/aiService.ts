import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './commandRunner.js';
import type { ProviderSettingsInput } from '../types.js';

export interface LanguagePolicy {
  conversationLanguage: string;
  artifactLanguage: 'en';
  source: 'AGENTS.md' | 'CONTEXT.md' | 'GLOSSARY.md' | 'operator_preference' | 'default';
  glossaryTerms: string[];
}

export interface RepoContextExploration {
  glossaryFound: boolean;
  contextFound: boolean;
  prdFound: boolean;
  adrFiles: string[];
  sourceFiles: string[];
  exemplarIssues: string[];
  glossaryTerms: string[];
  excerpts: Record<string, string>;
}

export interface RoleDispatchRequest {
  role:
    | 'requirement-critic'
    | 'research'
    | 'planner'
    | 'plan-critic'
    | 'implementer'
    | 'reviewer'
    | 'critic'
    | 'learner';
  repoRoot: string;
  slug?: string;
  issueRef?: string;
  attempt: number;
  prompt: string;
  context?: Record<string, unknown>;
}

export type RoleDispatcher = (req: RoleDispatchRequest) => Promise<Record<string, unknown>>;

export function resolveLanguagePolicy(
  repoRoot: string,
  operatorLanguage?: string,
): LanguagePolicy {
  const resolvedRoot = path.resolve(repoRoot);
  const agentsPath = path.join(resolvedRoot, 'AGENTS.md');
  const contextPath = path.join(resolvedRoot, 'CONTEXT.md');
  const glossaryPath = path.join(resolvedRoot, 'GLOSSARY.md');

  const glossaryTerms: string[] = [];
  for (const docPath of [glossaryPath, contextPath]) {
    if (fs.existsSync(docPath)) {
      const text = fs.readFileSync(docPath, 'utf-8');
      const matches = text.matchAll(/^[-*]\s+\*\*([^*]+)\*\*/gm);
      for (const m of matches) {
        glossaryTerms.push(m[1].trim());
      }
    }
  }

  const detectLangFromText = (text: string): string | null => {
    if (/pt-BR|portugu[eê]s|portuguese/i.test(text)) return 'pt-BR';
    if (/es-ES|espa[ñn]ol|spanish/i.test(text)) return 'es';
    if (/fr-FR|fran[cç]ais|french/i.test(text)) return 'fr';
    if (/english/i.test(text)) return 'en';
    return null;
  };

  if (fs.existsSync(agentsPath)) {
    const lang = detectLangFromText(fs.readFileSync(agentsPath, 'utf-8'));
    if (lang) {
      return {
        conversationLanguage: lang,
        artifactLanguage: 'en',
        source: 'AGENTS.md',
        glossaryTerms,
      };
    }
  }

  if (fs.existsSync(contextPath)) {
    const lang = detectLangFromText(fs.readFileSync(contextPath, 'utf-8'));
    if (lang) {
      return {
        conversationLanguage: lang,
        artifactLanguage: 'en',
        source: 'CONTEXT.md',
        glossaryTerms,
      };
    }
  }

  if (operatorLanguage) {
    return {
      conversationLanguage: operatorLanguage,
      artifactLanguage: 'en',
      source: 'operator_preference',
      glossaryTerms,
    };
  }

  return {
    conversationLanguage: 'en',
    artifactLanguage: 'en',
    source: 'default',
    glossaryTerms,
  };
}

export function exploreRepositoryContext(repoRoot: string): RepoContextExploration {
  const root = path.resolve(repoRoot);
  const glossaryPath = path.join(root, 'GLOSSARY.md');
  const contextPath = path.join(root, 'CONTEXT.md');
  const prdPath = path.join(root, 'PRD.md');

  const glossaryFound = fs.existsSync(glossaryPath);
  const contextFound = fs.existsSync(contextPath);
  const prdFound = fs.existsSync(prdPath);

  const excerpts: Record<string, string> = {};
  if (glossaryFound) excerpts['GLOSSARY.md'] = fs.readFileSync(glossaryPath, 'utf-8').slice(0, 1000);
  if (contextFound) excerpts['CONTEXT.md'] = fs.readFileSync(contextPath, 'utf-8').slice(0, 1000);
  if (prdFound) excerpts['PRD.md'] = fs.readFileSync(prdPath, 'utf-8').slice(0, 1000);

  const adrDir = path.join(root, 'docs', 'adr');
  const adrFiles = fs.existsSync(adrDir)
    ? fs
        .readdirSync(adrDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const rel = path.join('docs', 'adr', f);
          excerpts[rel] = fs.readFileSync(path.join(root, rel), 'utf-8').slice(0, 500);
          return rel;
        })
    : [];

  const sourceFiles: string[] = [];
  const walkSrc = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkSrc(full);
      } else if (entry.isFile() && /\.(ts|tsx|js|py|md)$/.test(entry.name)) {
        const rel = path.relative(root, full);
        sourceFiles.push(rel);
        if (Object.keys(excerpts).length < 10) {
          excerpts[rel] = fs.readFileSync(full, 'utf-8').slice(0, 500);
        }
      }
    }
  };
  walkSrc(path.join(root, 'src'));
  if (sourceFiles.length === 0 && fs.existsSync(path.join(root, 'README.md'))) {
    sourceFiles.push('README.md');
    excerpts['README.md'] = fs.readFileSync(path.join(root, 'README.md'), 'utf-8').slice(0, 500);
  }

  const exemplarIssues: string[] = [];
  const scratchDir = path.join(root, '.scratch');
  if (fs.existsSync(scratchDir)) {
    for (const d of fs.readdirSync(scratchDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const issDir = path.join(scratchDir, d.name, 'issues');
      if (fs.existsSync(issDir)) {
        for (const f of fs.readdirSync(issDir).filter((x) => x.endsWith('.md'))) {
          const rel = path.join('.scratch', d.name, 'issues', f);
          exemplarIssues.push(rel);
          excerpts[rel] = fs.readFileSync(path.join(root, rel), 'utf-8').slice(0, 500);
        }
      }
    }
  }

  const lang = resolveLanguagePolicy(root);
  return {
    glossaryFound,
    contextFound,
    prdFound,
    adrFiles,
    sourceFiles,
    exemplarIssues,
    glossaryTerms: lang.glossaryTerms,
    excerpts,
  };
}

/**
 * Multi-provider AI client supporting Anthropic, OpenAI, Google Gemini, OpenRouter, and Local CLI bridge.
 */
export async function callProviderModel(params: {
  prompt: string;
  settings: ProviderSettingsInput;
  repoRoot: string;
  jsonSchema?: Record<string, unknown>;
  onToken?: (chunk: string) => void;
}): Promise<string> {
  const { prompt, settings, repoRoot, jsonSchema, onToken } = params;

  if (settings.mode === 'sdk') {
    const prov = settings.activeProvider;
    const cfg = settings.providers?.[prov];
    if (cfg?.apiKey) {
      if (prov === 'anthropic') {
        const baseUrl = (cfg.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: cfg.model ?? 'claude-sonnet-4-6',
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { content?: Array<{ text?: string }> };
          const text = data.content?.[0]?.text ?? '';
          if (onToken && text) onToken(text);
          return text;
        }
      } else if (prov === 'gemini') {
        const model = cfg.model ?? 'gemini-2.5-pro';
        const baseUrl = (
          cfg.baseUrl ?? 'https://generativelanguage.googleapis.com'
        ).replace(/\/$/, '');
        const res = await fetch(
          `${baseUrl}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: jsonSchema
                ? { responseMimeType: 'application/json', responseSchema: jsonSchema }
                : undefined,
            }),
          },
        );
        if (res.ok) {
          const data = (await res.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
          if (onToken && text) onToken(text);
          return text;
        }
      } else {
        // OpenAI / OpenRouter compatible
        const defaultBase =
          prov === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1';
        const baseUrl = (cfg.baseUrl ?? defaultBase).replace(/\/$/, '');
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model ?? 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
            response_format: jsonSchema ? { type: 'json_object' } : undefined,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const text = data.choices?.[0]?.message?.content ?? '';
          if (onToken && text) onToken(text);
          return text;
        }
      }
    }
  } else if (settings.mode === 'cli' && settings.cliHarness && settings.providers?.cli?.baseUrl === 'enable-cli-exec') {
    const cli = settings.cliHarness;
    const args =
      cli === 'claude'
        ? ['claude', '-p', prompt]
        : cli === 'codex'
          ? ['codex', 'exec', prompt]
          : cli === 'agy'
            ? ['agy', '--print', prompt]
            : ['opencode', 'run', prompt];
    const res = await runCommand(args, { cwd: repoRoot, timeoutMs: 30_000 });
    if (res.exitCode === 0 && res.stdout.trim()) {
      const out = res.stdout.trim();
      if (onToken) onToken(out);
      return out;
    }
  }

  const lang = resolveLanguagePolicy(repoRoot);
  const fallback =
    lang.conversationLanguage === 'pt-BR'
      ? `Entendido. Contexto do repositório analisado (${lang.glossaryTerms.join(', ') || 'padrão'}). Como deseja prosseguir?`
      : `Understood. Repository context analyzed (${lang.glossaryTerms.join(', ') || 'default'}). How would you like to proceed?`;
  if (onToken) onToken(fallback);
  return fallback;
}

export async function generateCoordinatorResponse(
  prompt: string,
  settings: ProviderSettingsInput,
  repoRoot: string,
): Promise<string> {
  return callProviderModel({ prompt, settings, repoRoot });
}
