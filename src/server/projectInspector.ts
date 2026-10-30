import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findExecutable, resolveSkillDir, runCommand, runGantryScript } from './commandRunner.js';
import { GitError, git, readWorktreeStatus } from './git.js';
import type { LiveBadgeState, RegisteredProject } from '../types.js';

export interface SpecSummary {
  slug: string;
  title: string;
  status: string;
  path: string;
}

export interface IssueSummary {
  ref: string;
  slug: string;
  number: string;
  title: string;
  status: string;
  blockedBy: string[];
  path: string;
}

export interface ActiveAgentSummary {
  id: string;
  role: string;
  issueRef?: string;
  worktreePath: string;
  badgeState: LiveBadgeState;
}

export interface WorktreeSummary {
  path: string;
  head: string;
  branch: string;
  activeRunId: string | null;
  issueRef?: string;
  badgeState: LiveBadgeState;
  agents: ActiveAgentSummary[];
}

export interface RemediationCard {
  kind: 'ignored_policy' | 'dirty_worktree' | 'missing_skills';
  title: string;
  description: string;
  remediation: string;
}

export interface ProjectInspectionResult {
  projectId: string;
  unitId: string;
  path: string;
  skillPack: {
    found: boolean;
    source: 'repo' | 'global' | null;
    skillDir: string | null;
  };
  policy: Record<string, unknown>;
  hasTrackedPolicy: boolean;
  operatorProfile: Record<string, unknown>;
  agentsMd: string;
  roadmapMd: string;
  specs: SpecSummary[];
  issues: IssueSummary[];
  worktrees: WorktreeSummary[];
  inflightRuns: Array<Record<string, unknown>>;
  diagnostics: {
    policyIgnored: boolean;
    dirtyWorkingTree: boolean;
    dirtyFiles: string[];
  };
  remediationCards: RemediationCard[];
  trackedFiles: string[];
}

function parseField(markdown: string, key: string): string {
  const regex = new RegExp(`^${key}:\\s*(.+)$`, 'mi');
  const match = markdown.match(regex);
  return match ? match[1].trim() : '';
}

function parseTitle(markdown: string, fallback: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function scanArtifacts(
  repoRoot: string,
  policy: Record<string, unknown>,
): { specs: SpecSummary[]; issues: IssueSummary[] } {
  const artifactsCfg = (policy.artifacts ?? {}) as Record<string, string>;
  const specsTemplate = artifactsCfg.specs ?? '.scratch/{slug}/spec.md';
  const issuesTemplate = artifactsCfg.issues ?? '.scratch/{slug}/issues';

  // Determine parent directory before `{slug}`
  const slugIdx = specsTemplate.indexOf('{slug}');
  const baseRelDir =
    slugIdx > 0 ? specsTemplate.slice(0, slugIdx).replace(/\/+$/, '') : '.scratch';
  const baseDir = path.join(repoRoot, baseRelDir);

  const specs: SpecSummary[] = [];
  const issues: IssueSummary[] = [];

  if (!fs.existsSync(baseDir)) {
    return { specs, issues };
  }

  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const specRel = specsTemplate.replace('{slug}', slug);
    const specFile = path.join(repoRoot, specRel);
    if (fs.existsSync(specFile)) {
      const content = fs.readFileSync(specFile, 'utf-8');
      specs.push({
        slug,
        title: parseTitle(content, slug),
        status: parseField(content, 'Status') || 'draft',
        path: path.relative(repoRoot, specFile),
      });
    }

    const issuesRel = issuesTemplate.replace('{slug}', slug);
    const issuesDir = path.join(repoRoot, issuesRel);
    if (fs.existsSync(issuesDir)) {
      const files = fs.readdirSync(issuesDir).filter((f) => f.endsWith('.md')).sort();
      for (const file of files) {
        const fullPath = path.join(issuesDir, file);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const numMatch = file.match(/^(\d+)/);
        const num = numMatch ? numMatch[1] : '01';
        const sliceMatch = content.match(/^Slice:\s*`?([^`\n]+)`?/m);
        const ref = sliceMatch ? sliceMatch[1].trim() : `${slug}#${num}`;
        const blockedBySection = content.split(/^##\s+Blocked by/im)[1]?.split(/^##\s+/m)[0] ?? '';
        const blockedBy = blockedBySection
          .split('\n')
          .map((l) => l.replace(/^[-*]\s*/, '').trim())
          .filter((l) => l && l.toLowerCase() !== 'none');

        issues.push({
          ref,
          slug,
          number: num,
          title: parseTitle(content, file),
          status: parseField(content, 'Status') || 'draft',
          blockedBy,
          path: path.relative(repoRoot, fullPath),
        });
      }
    }
  }

  return { specs, issues };
}

export function deriveRunLogStates(
  stateRoot: string,
  unitId: string,
): {
  issueBadges: Record<string, LiveBadgeState>;
  activeRolesByIssue: Record<string, string | null>;
} {
  const runsDir = path.join(stateRoot, unitId, 'runs');
  const issueBadges: Record<string, LiveBadgeState> = {};
  const activeRolesByIssue: Record<string, string | null> = {};

  if (!fs.existsSync(runsDir)) {
    return { issueBadges, activeRolesByIssue };
  }

  const files = fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl')).sort();
  for (const file of files) {
    const content = fs.readFileSync(path.join(runsDir, file), 'utf-8');
    let currentIssue: string | undefined;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as {
          event: string;
          issue?: string;
          phase?: string;
          data?: Record<string, unknown>;
        };
        const issue = evt.issue ?? currentIssue;
        if (evt.issue) currentIssue = evt.issue;
        if (!issue) continue;

        if (evt.event === 'phase.started') {
          issueBadges[issue] = evt.data?.operatorWaiting ? 'needs input' : 'working';
        } else if (evt.event === 'operator.waiting') {
          issueBadges[issue] = 'needs input';
        } else if (evt.event === 'operator.approved') {
          issueBadges[issue] = 'working';
        } else if (evt.event === 'subagent.started') {
          activeRolesByIssue[issue] = String(evt.data?.role ?? 'subagent');
          issueBadges[issue] = 'working';
        } else if (evt.event === 'subagent.stopped') {
          activeRolesByIssue[issue] = null;
        } else if (evt.event === 'issue.paused' || evt.event === 'issue.blocked') {
          issueBadges[issue] = 'blocked';
          activeRolesByIssue[issue] = null;
        } else if (evt.event === 'issue.done') {
          issueBadges[issue] = 'done';
          activeRolesByIssue[issue] = null;
        }
      } catch {
        // skip malformed line
      }
    }
  }

  return { issueBadges, activeRolesByIssue };
}

export async function inspectProject(
  project: RegisteredProject,
  options: { stateRoot: string; profileRoot: string; homeDir?: string },
): Promise<ProjectInspectionResult> {
  const repoRoot = path.resolve(project.path);
  const skillPack = resolveSkillDir(repoRoot, options.homeDir);

  let policy: Record<string, unknown> = {};
  if (skillPack.skillDir) {
    const commonRes = await runGantryScript('common.py', ['--cwd', repoRoot, '--json'], {
      repoRoot,
      skillDir: skillPack.skillDir,
      env: { GANTRY_PROFILE_ROOT: options.profileRoot },
    });
    if (commonRes.exitCode === 0) {
      try {
        const parsed = JSON.parse(commonRes.stdout);
        policy = parsed.policy ?? {};
      } catch {
        // ignore parse error
      }
    }
  }

  const trackedPolicyPath = path.join(repoRoot, '.gantry', 'config.json');
  const hasTrackedPolicy = fs.existsSync(trackedPolicyPath);
  if (hasTrackedPolicy && Object.keys(policy).length === 0) {
    try {
      policy = JSON.parse(fs.readFileSync(trackedPolicyPath, 'utf-8'));
    } catch {
      // ignore
    }
  }

  const profileFile = path.join(options.profileRoot, project.unitId, 'execution.json');
  let operatorProfile: Record<string, unknown> = {};
  if (fs.existsSync(profileFile)) {
    try {
      operatorProfile = JSON.parse(fs.readFileSync(profileFile, 'utf-8'));
    } catch {
      // ignore
    }
  }

  const agentsPath = path.join(repoRoot, 'AGENTS.md');
  const roadmapPath = path.join(repoRoot, 'ROADMAP.md');
  const agentsMd = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf-8') : '';
  const roadmapMd = fs.existsSync(roadmapPath) ? fs.readFileSync(roadmapPath, 'utf-8') : '';

  const { specs, issues } = scanArtifacts(repoRoot, policy);

  let inflightRuns: Array<Record<string, unknown>> = [];
  if (skillPack.skillDir) {
    const infRes = await runGantryScript(
      'runlog.py',
      ['inflight', project.unitId, '--state-root', options.stateRoot, '--json'],
      { repoRoot, skillDir: skillPack.skillDir },
    );
    if (infRes.exitCode === 0) {
      try {
        inflightRuns = JSON.parse(infRes.stdout).inflight ?? [];
      } catch {
        // ignore
      }
    }
  }

  const { issueBadges, activeRolesByIssue } = deriveRunLogStates(options.stateRoot, project.unitId);

  const worktrees: WorktreeSummary[] = [];
  const wtRes = await runCommand(['git', 'worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (wtRes.exitCode === 0) {
    const blocks = wtRes.stdout.trim().split(/\n\n+/);
    for (const block of blocks) {
      if (!block.trim()) continue;
      let wtPath = '';
      let head = '';
      let branch = 'detached';
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length).trim();
        else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim();
        else if (line.startsWith('branch ')) {
          branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
        }
      }
      if (wtPath) {
        let activeRunId: string | null = null;
        if (skillPack.skillDir && fs.existsSync(wtPath)) {
          const curRes = await runGantryScript('runlog.py', ['current', '--cwd', wtPath, '--json'], {
            repoRoot: wtPath,
            skillDir: skillPack.skillDir,
          });
          if (curRes.exitCode === 0 && curRes.stdout.trim()) {
            try {
              const curJson = JSON.parse(curRes.stdout);
              activeRunId = curJson.run ?? null;
            } catch {
              activeRunId = curRes.stdout.trim() || null;
            }
          }
        }
        const matchingInflight = inflightRuns.find((r) => r.worktree === wtPath);
        const issueRef = matchingInflight?.issue ? String(matchingInflight.issue) : undefined;
        const badgeState: LiveBadgeState =
          (issueRef && issueBadges[issueRef]) ||
          (matchingInflight ? 'working' : activeRunId ? 'working' : 'idle');

        const agents: ActiveAgentSummary[] = [];
        if (issueRef && activeRolesByIssue[issueRef]) {
          agents.push({
            id: `agent-${issueRef}-${activeRolesByIssue[issueRef]}`,
            role: activeRolesByIssue[issueRef]!,
            issueRef,
            worktreePath: wtPath,
            badgeState,
          });
        }

        worktrees.push({
          path: wtPath,
          head,
          branch,
          activeRunId,
          issueRef,
          badgeState,
          agents,
        });
      }
    }
  }

  const ignoreRes = await runCommand(['git', 'check-ignore', '.gantry/config.json'], {
    cwd: repoRoot,
  });
  const policyIgnored = ignoreRes.exitCode === 0;

  // Plain folders are valid workspace projects; only Git checkouts have a worktree status.
  const status = wtRes.exitCode === 0 ? await readWorktreeStatus(repoRoot) : { files: [] };
  const dirtyFiles = status.files.map(file => `${file.status} ${file.path}`.trim());
  const dirtyWorkingTree = dirtyFiles.length > 0;
  const tracked = await runCommand(['git', 'ls-files'], { cwd: repoRoot });
  const trackedFiles = tracked.exitCode === 0
    ? tracked.stdout.split('\n').filter((filename) => filename && !filename.startsWith('.')).slice(0, 40)
    : [];

  const remediationCards: RemediationCard[] = [];
  if (policyIgnored) {
    remediationCards.push({
      kind: 'ignored_policy',
      title: 'Ignored Repository Policy (.gantry/config.json)',
      description:
        '.gantry/config.json matches a .gitignore rule. Gantry requires tracked Repository Policy for portability, or machine-local operator profiles under ~/.gantry/profiles/<unitId>/execution.json.',
      remediation:
        'Remove .gantry/ from .gitignore or save your personal host/role preferences to the machine-local operator profile.',
    });
  }
  if (dirtyWorkingTree) {
    remediationCards.push({
      kind: 'dirty_worktree',
      title: 'Árvore de trabalho com alterações',
      description: `O projeto tem ${dirtyFiles.length} alteração(ões) sem commit. A execução exige uma árvore de trabalho limpa.`,
      remediation: 'Faça commit das alterações ou use Limpar worktree para guardá-las em um backup no Git stash.',
    });
  }
  if (!skillPack.found) {
    remediationCards.push({
      kind: 'missing_skills',
      title: 'Gantry Skill Pack Not Installed',
      description: 'No local or global Gantry skill pack was detected for this repository.',
      remediation: 'Click Install / Update Gantry Skills to bootstrap the repository.',
    });
  }

  return {
    projectId: project.id,
    unitId: project.unitId,
    path: repoRoot,
    skillPack,
    policy,
    hasTrackedPolicy,
    operatorProfile,
    agentsMd,
    roadmapMd,
    specs,
    issues,
    worktrees,
    inflightRuns,
    diagnostics: {
      policyIgnored,
      dirtyWorkingTree,
      dirtyFiles,
    },
    remediationCards,
    trackedFiles,
  };
}

async function setupGit(repoRoot: string, args: string[]): Promise<string> {
  try { return await git(repoRoot, ...args); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Não foi possível registrar a instalação do Gantry: ${detail}. Revise os arquivos e faça commit antes de executar o Gantry.`;
    if (error instanceof GitError) throw new GitError(message, error.code);
    throw new Error(message);
  }
}

async function requireCleanSetupTree(repoRoot: string): Promise<void> {
  const status = await readWorktreeStatus(repoRoot);
  if (status.files.length) {
    throw new Error('Faça commit ou stash das alterações existentes antes de instalar ou configurar o Gantry. A instalação cria commits locais na branch atual.');
  }
  // Fail before writing if Git cannot create the installation commit.
  await setupGit(repoRoot, ['var', 'GIT_AUTHOR_IDENT']);
  await setupGit(repoRoot, ['var', 'GIT_COMMITTER_IDENT']);
}

async function commitSetupFiles(repoRoot: string, paths: string[], message: string): Promise<void> {
  const changed = await setupGit(repoRoot, ['ls-files', '--modified', '--others', '--exclude-standard', '-z', '--', ...paths]);
  const files = [...new Set(changed.split('\0').filter(Boolean))];
  if (files.length === 0) return;
  await setupGit(repoRoot, ['add', '--', ...files]);
  await setupGit(repoRoot, ['commit', '--only', '-m', message, '--', ...files]);
}

export async function bootstrapProjectSkills(
  repoRoot: string,
  homeDir: string = os.homedir(),
): Promise<{ installed: boolean; targetDir: string; sourceDir: string }> {
  const resolvedRepo = path.resolve(repoRoot);
  const targetDir = path.join(resolvedRepo, '.agents', 'skills', 'gantry');
  const globalSkillDir = path.join(homeDir, '.agents', 'skills', 'gantry');

  if (!fs.existsSync(globalSkillDir)) {
    throw new Error(`Global Gantry skill pack not found at ${globalSkillDir}`);
  }

  await requireCleanSetupTree(resolvedRepo);
  const ignored = await runCommand(['git', 'check-ignore', '--no-index', '--', '.agents/skills/gantry/SKILL.md'], { cwd: resolvedRepo });
  if (ignored.exitCode === 0) {
    throw new Error('As skills do Gantry estão ignoradas pelo Git. Ajuste as regras de ignore para .agents/skills/gantry antes de instalar.');
  }
  if (ignored.exitCode !== 1) {
    throw new Error(`Não foi possível verificar as regras de ignore: ${ignored.stderr.trim()}`);
  }
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(fs.realpathSync(globalSkillDir), targetDir, {
    recursive: true,
    force: true,
    filter: (source) => path.basename(source) !== '__pycache__' && !source.endsWith('.pyc'),
  });
  await commitSetupFiles(resolvedRepo, ['.agents/skills/gantry'], 'chore: install Gantry skills');

  return {
    installed: true,
    targetDir,
    sourceDir: fs.realpathSync(globalSkillDir),
  };
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  supportedEfforts?: string[];
}

export function codexModelsFromDebugCatalog(value: unknown): DiscoveredModel[] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const entries = Array.isArray(record.models) ? record.models : [];
  const models: DiscoveredModel[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const model = entry as Record<string, unknown>;
    if (model.visibility === 'hide') continue;
    const id = typeof model.slug === 'string' ? model.slug : typeof model.id === 'string' ? model.id : '';
    if (!id) continue;
    const efforts = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels.flatMap((level) => {
          if (typeof level === 'string') return [level];
          if (level && typeof level === 'object' && typeof (level as { effort?: unknown }).effort === 'string') {
            return [(level as { effort: string }).effort];
          }
          return [];
        })
      : [];
    models.push({
      id,
      ...(typeof model.display_name === 'string' ? { name: model.display_name } : {}),
      ...(typeof model.context_window === 'number' ? { contextWindow: model.context_window } : {}),
      ...(efforts.length ? { supportedEfforts: efforts } : {}),
    });
  }
  return models;
}

function discoveryFailureText(stdout: string, stderr: string): string {
  const raw = (stderr || stdout || '').trim();
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // The pack also reports plain text.
  }
  return raw;
}

async function discoverCodexModelsFromDebugCommand(): Promise<Record<string, unknown>> {
  const codex = findExecutable('codex');
  if (!codex) throw new Error('Codex não está no PATH. Instale e autentique o CLI para listar os modelos.');
  const result = await runCommand([codex, 'debug', 'models'], { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'codex debug models falhou.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('codex debug models não retornou um catálogo JSON.');
  }
  const models = codexModelsFromDebugCatalog(parsed);
  if (!models.length) throw new Error('O Codex não retornou modelos visíveis.');
  return {
    harness: 'codex',
    models,
    provenance: { source: 'codex debug models' },
  };
}

export async function discoverHarnessModels(
  repoRoot: string,
  harness: string,
): Promise<Record<string, unknown>> {
  const skillPack = resolveSkillDir(repoRoot);
  if (!skillPack.skillDir) {
    throw new Error('Gantry skill pack not found');
  }
  const res = await runGantryScript('discovery.py', ['--harness', harness, '--json'], {
    repoRoot,
    skillDir: skillPack.skillDir,
  });
  if (res.exitCode === 0) {
    return JSON.parse(res.stdout) as Record<string, unknown>;
  }
  const failure = discoveryFailureText(res.stdout, res.stderr);
  if (harness === 'codex' && /stdin is not a terminal|unrecognized subcommand/i.test(failure)) {
    return discoverCodexModelsFromDebugCommand();
  }
  throw new Error(failure || `Model discovery failed for ${harness}`);
}

export async function resolveProjectRoles(
  repoRoot: string,
  profileRoot: string,
): Promise<{ roles: Record<string, { harness: string; model: string; effort?: string }> }> {
  const skillPack = resolveSkillDir(repoRoot);
  if (!skillPack.skillDir) {
    throw new Error('Gantry skill pack not found');
  }
  const res = await runGantryScript('execution.py', ['resolve', '--cwd', repoRoot, '--json'], {
    repoRoot,
    skillDir: skillPack.skillDir,
    env: { GANTRY_PROFILE_ROOT: profileRoot },
  });
  if (res.exitCode !== 0) {
    throw new Error(res.stderr || res.stdout || 'Failed to resolve roles');
  }
  const parsed = JSON.parse(res.stdout);
  return { roles: parsed.roles ?? parsed };
}

function mergePolicyObjects(
  base: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(update)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergePolicyObjects(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = structuredClone(v);
    }
  }
  return out;
}

export async function previewRepositorySetup(
  repoRoot: string,
  policy: Record<string, unknown>,
  profileRoot: string,
  mode: 'overwrite' | 'merge' = 'overwrite',
): Promise<{ diff: string; rawPreview: string; exitCode: number }> {
  const skillPack = resolveSkillDir(repoRoot);
  if (!skillPack.skillDir) {
    throw new Error('Gantry skill pack not found');
  }
  const configPath = path.join(repoRoot, '.gantry', 'config.json');
  const exists = fs.existsSync(configPath);
  const abortInput = exists ? 'a\n' : 'n\n';

  const res = await runGantryScript('setup.py', ['--config', JSON.stringify(policy)], {
    repoRoot,
    skillDir: skillPack.skillDir,
    input: abortInput,
    env: { GANTRY_PROFILE_ROOT: profileRoot },
  });

  const beforeObj = exists ? (JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>) : {};
  const effectivePolicy = exists && mode === 'merge' ? mergePolicyObjects(beforeObj, policy) : policy;

  const beforeContent = exists ? fs.readFileSync(configPath, 'utf-8') : '';
  const afterContent = JSON.stringify(effectivePolicy, null, 2) + '\n';
  const diffHeader = `--- a/.gantry/config.json\n+++ b/.gantry/config.json\n`;
  const diffBody = [
    ...beforeContent
      .split('\n')
      .filter(Boolean)
      .map((l) => `- ${l}`),
    ...afterContent
      .split('\n')
      .filter(Boolean)
      .map((l) => `+ ${l}`),
  ].join('\n');

  const agentsDiff = `--- a/AGENTS.md\n+++ b/AGENTS.md\n+ <!-- gantry:begin -->\n+ ## Gantry Repository Policy\n+ <!-- gantry:end -->`;

  return {
    diff: `${diffHeader}${diffBody}\n\n${agentsDiff}\n\n${res.stdout}`,
    rawPreview: res.stdout,
    exitCode: res.exitCode,
  };
}

export async function applyRepositorySetup(
  repoRoot: string,
  input: {
    scope: 'repository' | 'personal';
    policy?: Record<string, unknown>;
    mode?: 'overwrite' | 'merge';
    hostHarness?: string;
    roles?: Record<string, unknown>;
  },
  profileRoot: string,
): Promise<{ applied: boolean; stdout: string; stderr: string }> {
  const skillPack = resolveSkillDir(repoRoot);
  if (!skillPack.skillDir) {
    throw new Error('Gantry skill pack not found');
  }

  if (input.scope === 'personal') {
    const args = ['--personal', '--apply'];
    if (input.hostHarness) {
      args.push('--host', input.hostHarness);
    }
    if (input.roles) {
      args.push('--roles', JSON.stringify(input.roles));
    }
    const res = await runGantryScript('setup.py', args, {
      repoRoot,
      skillDir: skillPack.skillDir,
      input: 'y\n',
      env: { GANTRY_PROFILE_ROOT: profileRoot },
    });
    return {
      applied: res.exitCode === 0,
      stdout: res.stdout,
      stderr: res.stderr,
    };
  }

  await requireCleanSetupTree(repoRoot);
  const configPath = path.join(repoRoot, '.gantry', 'config.json');
  const exists = fs.existsSync(configPath);
  const confirmChar = exists ? (input.mode === 'merge' ? 'm\n' : 'o\n') : 'y\n';

  const res = await runGantryScript('setup.py', ['--config', JSON.stringify(input.policy ?? {})], {
    repoRoot,
    skillDir: skillPack.skillDir,
    input: confirmChar,
    env: { GANTRY_PROFILE_ROOT: profileRoot },
  });

  if (res.exitCode === 0) {
    await commitSetupFiles(repoRoot, [
      '.gantry/config.json', 'AGENTS.md', '.claude/settings.json', '.agents/hooks.json',
    ], 'chore: configure Gantry');
  }

  return {
    applied: res.exitCode === 0,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}
