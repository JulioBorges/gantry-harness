import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveSkillDir, runGantryScript } from './commandRunner.js';
import {
  exploreRepositoryContext,
  resolveLanguagePolicy,
  type RoleDispatcher,
} from './aiService.js';
import type { HarnessStateStore } from './stateStore.js';
import type { DecisionCardPayload, RegisteredProject } from '../types.js';

export interface PlanSessionState {
  slug: string;
  goal: string;
  runId: string;
  sessionId: string;
  roundNumber: number;
  answers: Record<string, string>;
}

const activePlanSessions = new Map<string, PlanSessionState>();

export function slugifyGoal(goal: string): string {
  return (
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'feature-slice'
  );
}

async function appendRunEvent(options: {
  repoRoot: string;
  skillDir: string;
  stateRoot: string;
  unitId: string;
  runId: string;
  event: string;
  issue?: string;
  phase?: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    run: options.runId,
    event: options.event,
  };
  if (options.issue) payload.issue = options.issue;
  if (options.phase) payload.phase = options.phase;
  if (options.data) payload.data = options.data;

  await runGantryScript(
    'runlog.py',
    ['append', options.unitId, options.runId, '--state-root', options.stateRoot],
    {
      repoRoot: options.repoRoot,
      skillDir: options.skillDir,
      input: JSON.stringify(payload),
    },
  );
}

function buildLocalizedGrillingCard(params: {
  slug: string;
  goal: string;
  roundNumber: number;
  conversationLanguage: string;
  glossaryTerms: string[];
  sourceFiles: string[];
  planPhases: Array<{
    name: string;
    questions: Array<{ id: string; question: string; recommended_answer: string }>;
  }>;
}): DecisionCardPayload {
  const { slug, goal, roundNumber, conversationLanguage, glossaryTerms, sourceFiles, planPhases } =
    params;
  const isPt = conversationLanguage === 'pt-BR';
  const domainTerms = glossaryTerms.length > 0 ? glossaryTerms.join(', ') : slug;
  const primaryFile = sourceFiles[0] ?? 'README.md';
  const phase = planPhases[(roundNumber - 1) % Math.max(planPhases.length, 1)];

  if (phase && phase.questions.length > 0) {
    return {
      kind: 'grilling_round',
      slug,
      roundNumber,
      questions: phase.questions.map((q, idx) => ({
        id: q.id || `q${roundNumber}_${idx + 1}`,
        title: isPt
          ? `${idx + 1}. ${phase.name} (${domainTerms} em ${primaryFile})`
          : `${idx + 1}. ${phase.name} (${domainTerms} in ${primaryFile})`,
        body: isPt ? `[${goal}] ${q.question} (Contexto: ${domainTerms})` : q.question,
        options: [
          {
            label: isPt ? 'Recomendado (Padrão)' : 'Recommended',
            description: q.recommended_answer,
          },
          {
            label: isPt ? 'Alternativa Customizada' : 'Custom Alternative',
            description: isPt
              ? 'Definir restrição específica para este módulo'
              : 'Define a custom constraint for this module',
          },
        ],
        recommendedAnswer: q.recommended_answer,
      })),
    };
  }

  return {
    kind: 'grilling_round',
    slug,
    roundNumber,
    questions: [
      {
        id: `q${roundNumber}_1`,
        title: isPt
          ? `1. Fronteira Pública (${domainTerms} / ${primaryFile})`
          : `1. Public Seam (${domainTerms} / ${primaryFile})`,
        body: isPt
          ? `Para "${goal}", qual deve ser o contrato público principal?`
          : `For "${goal}", what should the primary public contract be?`,
        recommendedAnswer: 'Expose a deterministic HTTP/function seam with strict validation.',
      },
    ],
  };
}

export async function startPlanWorkflow(params: {
  project: RegisteredProject;
  store: HarnessStateStore;
  stateRoot: string;
  profileRoot: string;
  goal: string;
  slug?: string;
  sessionId?: string;
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<{
  slug: string;
  runId: string;
  sessionId: string;
  languagePolicy: ReturnType<typeof resolveLanguagePolicy>;
  contextExplored: ReturnType<typeof exploreRepositoryContext>;
  decisionCard: DecisionCardPayload;
  messageId: string;
}> {
  const { project, store, stateRoot } = params;
  const repoRoot = path.resolve(project.path);
  const skillDir = resolveSkillDir(repoRoot).skillDir;
  if (!skillDir) {
    throw new Error('Gantry skill pack not found');
  }

  // Query Gantry's plan.py --goal <goal> --json for grounded Socratic Gate phases
  const planGoalRes = await runGantryScript('plan.py', ['--goal', params.goal, '--json'], {
    repoRoot,
    skillDir,
  });
  const planGoalData =
    planGoalRes.exitCode === 0
      ? (JSON.parse(planGoalRes.stdout) as {
          slug?: string;
          phases?: Array<{
            name: string;
            questions: Array<{ id: string; question: string; recommended_answer: string }>;
          }>;
        })
      : {};

  const slug = params.slug || planGoalData.slug || slugifyGoal(params.goal);
  const sessions = store.listSessions(project.id);
  const sessionId =
    params.sessionId ?? sessions[0]?.id ?? store.createSession(project.id, `Plan: ${slug}`, slug).id;

  const languagePolicy = resolveLanguagePolicy(repoRoot);
  const contextExplored = exploreRepositoryContext(repoRoot);

  const runId = `run-plan-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
  const issueRef = `${slug}#01`;

  activePlanSessions.set(`${project.id}:${slug}`, {
    slug,
    goal: params.goal,
    runId,
    sessionId,
    roundNumber: 1,
    answers: {},
  });

  await appendRunEvent({
    repoRoot,
    skillDir,
    stateRoot,
    unitId: project.unitId,
    runId,
    event: 'run.started',
    data: {
      repositoryRoot: repoRoot,
      policyHash: crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 12),
      tier: 'supported',
      staleAfterSeconds: 900,
    },
  });

  await appendRunEvent({
    repoRoot,
    skillDir,
    stateRoot,
    unitId: project.unitId,
    runId,
    event: 'phase.started',
    issue: issueRef,
    phase: 'Plan',
    data: {
      operatorWaiting: true,
    },
  });

  const decisionCard = buildLocalizedGrillingCard({
    slug,
    goal: params.goal,
    roundNumber: 1,
    conversationLanguage: languagePolicy.conversationLanguage,
    glossaryTerms: contextExplored.glossaryTerms,
    sourceFiles: contextExplored.sourceFiles,
    planPhases: planGoalData.phases ?? [],
  });

  store.updateProjectState(project.id, {
    lifecycleState: 'grilling_interview',
    badgeState: 'needs input',
  });

  const domainHint =
    contextExplored.glossaryTerms.length > 0
      ? contextExplored.glossaryTerms.join(', ')
      : contextExplored.sourceFiles.join(', ');

  const promptContent =
    languagePolicy.conversationLanguage === 'pt-BR'
      ? `Iniciando entrevista Socratic Gate para **${slug}** (${params.goal} — termos: ${domainHint}). Responda às decisões abaixo:`
      : `Starting Socratic Gate grilling for **${slug}** (${params.goal} — terms: ${domainHint}). Please review the decisions below:`;

  const msg = store.appendMessage({
    projectId: project.id,
    sessionId,
    role: 'assistant',
    content: promptContent,
    decisionCard,
  });

  params.broadcast({
    type: 'plan.grilling_round',
    projectId: project.id,
    sessionId,
    runId,
    slug,
    message: msg,
  });
  params.broadcast({
    type: 'alert.triggered',
    projectId: project.id,
    projectName: project.name,
    sessionId,
    messageId: msg.id,
    badgeState: 'needs input',
    cardKind: 'grilling_round',
  });

  return {
    slug,
    runId,
    sessionId,
    languagePolicy,
    contextExplored,
    decisionCard,
    messageId: msg.id,
  };
}

function normalizeToEnglishArtifactText(text: string): string {
  // Translate common Portuguese operator phrases into canonical English artifact prose
  return text
    .replace(/\bEntregar\b/gi, 'Deliver')
    .replace(/\bassinado\b/gi, 'signed')
    .replace(/\btentativas?\b/gi, 'retries')
    .replace(/\bautentica[cç][aã]o\b/gi, 'authentication');
}

function buildCanonicalEnglishSpec(
  slug: string,
  goal: string,
  answers: Record<string, string>,
  amendment?: string,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const settledSummary = Object.entries(answers)
    .map(([k, v]) => `- **${k}**: ${normalizeToEnglishArtifactText(v)}`)
    .join('\n');
  const extraConstraint = amendment
    ? `\n- **Refinement**: ${normalizeToEnglishArtifactText(amendment)}`
    : '';

  return [
    `# Spec: ${slug}`,
    ``,
    `Type: spec`,
    `Status: draft`,
    `Map: none`,
    `Source: socratic-gate`,
    `Created: ${today}`,
    ``,
    `## Blueprint`,
    ``,
    `### Context`,
    ``,
    `Implement ${normalizeToEnglishArtifactText(goal)} for the ${slug} capability based on settled Socratic Gate decisions.`,
    ``,
    `### Architecture`,
    ``,
    `${settledSummary || '- Deterministic module boundary with explicit public contract.'}`,
    ``,
    `### Constraints`,
    ``,
    `- Maintain strict backward compatibility with existing repository modules.${extraConstraint}`,
    ``,
    `## Contract`,
    ``,
    `### Definition of Done`,
    ``,
    `- [ ] Public interface and prefactoring foundation implemented in slice 01 for ${normalizeToEnglishArtifactText(goal)}`,
    `- [ ] Core end-to-end behavior and integration tests verified in slice 02 for ${normalizeToEnglishArtifactText(goal)}`,
    ``,
    `### Regression Guardrails`,
    ``,
    `- Existing test suite and repository checks must remain green.`,
    `- No unvalidated inputs or silent fallbacks are permitted.`,
    ``,
    `### Scenarios`,
    ``,
    '```gherkin',
    `Scenario: Valid request is processed deterministically`,
    `  Given the ${slug} module is initialized`,
    `  When a valid payload is submitted to the ${slug} boundary`,
    `  Then the operation succeeds and returns a verified result`,
    '```',
    ``,
    `## Out of Scope`,
    ``,
    `- Unrelated third-party service migrations.`,
    ``,
    `## Changelog`,
    ``,
    `- ${today}: Initial Spec synthesized from Socratic Gate decisions.`,
    ``,
  ].join('\n');
}

function parseExistingIssueFiles(
  repoRoot: string,
  slug: string,
): Array<{
  num: string;
  ref: string;
  path: string;
  fullPath: string;
  title: string;
  whatToBuild: string;
  filesToRead: string[];
  criteria: string[];
  blockedBy: string[];
}> {
  const issuesDir = path.join(repoRoot, '.scratch', slug, 'issues');
  if (!fs.existsSync(issuesDir)) return [];
  const files = fs.readdirSync(issuesDir).filter((f) => f.endsWith('.md')).sort();
  return files.map((file) => {
    const fullPath = path.join(issuesDir, file);
    const content = fs.readFileSync(fullPath, 'utf-8');
    const numMatch = file.match(/^(\d+)/);
    const num = numMatch ? numMatch[1] : '01';
    const ref = `${slug}#${num}`;
    const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file;
    const whatSection =
      content.split(/^##\s+What to build\s*$/im)[1]?.split(/^###\s+Files to read/im)[0]?.trim() ??
      '';
    const filesSection =
      content.split(/^###\s+Files to read\s*$/im)[1]?.split(/^##\s+/m)[0] ?? '';
    const filesToRead = Array.from(filesSection.matchAll(/^\s*-\s+`([^`]+)`/gm)).map((m) => m[1]);
    const criteriaSection =
      content.split(/^##\s+Acceptance criteria\s*$/im)[1]?.split(/^##\s+/m)[0] ?? '';
    const criteria = Array.from(criteriaSection.matchAll(/^\s*-\s+\[[ xX]\]\s+(.+)$/gm)).map((m) =>
      m[1].trim(),
    );
    const blockedBySection =
      content.split(/^##\s+Blocked by\s*$/im)[1]?.split(/^##\s+/m)[0] ?? '';
    const blockedBy = blockedBySection
      .split('\n')
      .map((l) => l.replace(/^[-*]\s*/, '').trim())
      .filter((l) => l && l.toLowerCase() !== 'none');

    return {
      num,
      ref,
      path: path.join('.scratch', slug, 'issues', file),
      fullPath,
      title,
      whatToBuild: whatSection,
      filesToRead: filesToRead.length > 0 ? filesToRead : ['README.md'],
      criteria: criteria.length > 0 ? criteria : [`Verify ${ref}`],
      blockedBy,
    };
  });
}

function writeNormalizedIssueList(
  repoRoot: string,
  slug: string,
  items: Array<{
    title: string;
    whatToBuild: string;
    filesToRead: string[];
    criteria: string[];
    blockedByIndices: number[];
  }>,
): Array<{
  ref: string;
  path: string;
  title: string;
  criteriaCount: number;
  blockedBy: string[];
}> {
  const today = new Date().toISOString().slice(0, 10);
  const issuesDir = path.join(repoRoot, '.scratch', slug, 'issues');
  fs.mkdirSync(issuesDir, { recursive: true });
  for (const f of fs.readdirSync(issuesDir)) {
    if (f.endsWith('.md')) fs.unlinkSync(path.join(issuesDir, f));
  }

  const out: Array<{
    ref: string;
    path: string;
    title: string;
    criteriaCount: number;
    blockedBy: string[];
  }> = [];

  items.forEach((item, idx) => {
    const num = String(idx + 1).padStart(2, '0');
    const ref = `${slug}#${num}`;
    const fileSlug = `${num}-${slugifyGoal(item.title)}.md`;
    const relPath = path.join('.scratch', slug, 'issues', fileSlug);
    const fullPath = path.join(repoRoot, relPath);
    const blockedBy = item.blockedByIndices
      .filter((bIdx) => bIdx >= 0 && bIdx < items.length && bIdx !== idx)
      .map((bIdx) => `${slug}#${String(bIdx + 1).padStart(2, '0')}`);

    const content = [
      `# ${item.title}`,
      ``,
      `Type: issue`,
      `Status: draft`,
      `Slice: \`${ref}\``,
      `Spec: \`.scratch/${slug}/spec.md\``,
      `Created: ${today}`,
      ``,
      `## Parent`,
      ``,
      `- Spec: \`.scratch/${slug}/spec.md\``,
      ``,
      `## What to build`,
      ``,
      item.whatToBuild,
      ``,
      `### Files to read`,
      ``,
      ...item.filesToRead.map((f) => `- \`${f}\``),
      ``,
      `## Acceptance criteria`,
      ``,
      ...item.criteria.map((c) => `- [ ] ${c}`),
      ``,
      `## Blocked by`,
      ``,
      blockedBy.length > 0 ? blockedBy.map((b) => `- ${b}`).join('\n') : '- None',
      ``,
      `## Comments`,
      ``,
    ].join('\n');

    fs.writeFileSync(fullPath, content, 'utf-8');
    out.push({
      ref,
      path: relPath,
      title: item.title,
      criteriaCount: item.criteria.length,
      blockedBy,
    });
  });

  return out;
}

export async function sliceAndCritiquePlan(params: {
  project: RegisteredProject;
  store: HarnessStateStore;
  slug: string;
  sessionId: string;
  preserveExistingIssues?: boolean;
  roleDispatcher?: RoleDispatcher;
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<{
  specValidation: Record<string, unknown>;
  planCriticAutoRevised: boolean;
  decisionCard: DecisionCardPayload;
  messageId?: string;
}> {
  const { project, store, slug, sessionId } = params;
  const repoRoot = path.resolve(project.path);
  const skillDir = resolveSkillDir(repoRoot).skillDir!;
  const specRelPath = path.join('.scratch', slug, 'spec.md');

  const specCheckRes = await runGantryScript(
    'spec.py',
    [specRelPath, '--check', '--cwd', repoRoot, '--json'],
    { repoRoot, skillDir },
  );
  const specValidation = JSON.parse(specCheckRes.stdout) as Record<string, unknown>;
  if (!specValidation.valid) {
    const blockedCard: DecisionCardPayload = {
      kind: 'spec_blocked',
      slug,
      source: 'spec_structural_validation',
      findings: [{ quote: specRelPath, reason: 'Spec failed structural validation' }],
    };
    store.updateProjectState(project.id, {
      lifecycleState: 'spec_validation',
      badgeState: 'blocked',
    });
    const msg = store.appendMessage({
      projectId: project.id,
      sessionId,
      role: 'assistant',
      content: `Spec structural validation failed for **${slug}**.`,
      decisionCard: blockedCard,
    });
    params.broadcast({ type: 'plan.spec_blocked', projectId: project.id, slug, message: msg });
    params.broadcast({
      type: 'alert.triggered',
      projectId: project.id,
      projectName: project.name,
      sessionId,
      messageId: msg.id,
      badgeState: 'blocked',
      cardKind: 'spec_blocked',
    });
    return {
      specValidation,
      planCriticAutoRevised: false,
      decisionCard: blockedCard,
      messageId: msg.id,
    };
  }

  store.updateProjectState(project.id, {
    lifecycleState: 'slicing_and_critique',
    badgeState: 'working',
  });

  const ctx = exploreRepositoryContext(repoRoot);
  const primaryFile = ctx.sourceFiles[0] ?? 'README.md';

  let draftIssues = parseExistingIssueFiles(repoRoot, slug).map((iss) => ({
    ref: iss.ref,
    path: iss.path,
    title: iss.title,
    criteriaCount: iss.criteria.length,
    blockedBy: iss.blockedBy,
  }));

  if (!params.preserveExistingIssues || draftIssues.length === 0) {
    // Invoke Gantry's plan.py --spec <specRelPath> --json to slice vertical tracer bullets
    await runGantryScript('plan.py', ['--spec', specRelPath, '--json'], {
      repoRoot,
      skillDir,
    });
    // Normalize files_to_read so they reference real existing files in the repository for budget.py
    const parsedFromPlanPy = parseExistingIssueFiles(repoRoot, slug);
    draftIssues = writeNormalizedIssueList(
      repoRoot,
      slug,
      parsedFromPlanPy.map((item, idx) => ({
        title: item.title,
        whatToBuild: item.whatToBuild,
        filesToRead: [primaryFile],
        criteria: item.criteria,
        blockedByIndices: idx === 0 ? [] : [0],
      })),
    );
  }

  // Validate planner result contract via result.py --role planner --json
  const plannerContract = {
    filesWritten: draftIssues.map((i) => i.path),
    issues: draftIssues,
    roadmapAdditions: draftIssues.map((i) => i.ref),
    openDecisions: [],
  };
  const plannerCheck = await runGantryScript('result.py', ['--role', 'planner', '--json'], {
    repoRoot,
    skillDir,
    input: JSON.stringify(plannerContract),
  });
  if (plannerCheck.exitCode !== 0) {
    throw new Error(`Planner result failed contract validation: ${plannerCheck.stdout}`);
  }

  // Run Plan Critic (via roleDispatcher if provided, plus frontier.py DAG validation)
  const frontierRes = await runGantryScript(
    'frontier.py',
    ['--scope', slug, '--include-parked', '--json'],
    { repoRoot, skillDir },
  );
  const frontierData =
    frontierRes.exitCode === 0
      ? (JSON.parse(frontierRes.stdout) as { errors?: string[]; rounds?: string[][] })
      : { errors: ['frontier.py failed'] };

  let criticVerdict: {
    acceptable: boolean;
    problems: Array<{ problem: string; fix: string }>;
    frontierErrors: string[];
  } = {
    acceptable: (frontierData.errors ?? []).length === 0,
    problems: [],
    frontierErrors: frontierData.errors ?? [],
  };

  if (params.roleDispatcher) {
    const dispatched = await params.roleDispatcher({
      role: 'plan-critic',
      repoRoot,
      slug,
      attempt: 1,
      prompt: `Audit draft issues for ${slug}`,
      context: { issues: draftIssues },
    });
    criticVerdict = {
      acceptable: Boolean(dispatched.acceptable),
      problems: (dispatched.problems as Array<{ problem: string; fix: string }>) ?? [],
      frontierErrors: (dispatched.frontierErrors as string[]) ?? [],
    };
  }

  const firstCriticCheck = await runGantryScript('result.py', ['--role', 'plan-critic', '--json'], {
    repoRoot,
    skillDir,
    input: JSON.stringify(criticVerdict),
  });
  if (firstCriticCheck.exitCode !== 0) {
    throw new Error(`Plan Critic result failed contract validation: ${firstCriticCheck.stdout}`);
  }

  // One automatic planner revision pass if Plan Critic refuted the initial draft!
  let planCriticAutoRevised = false;
  if (!criticVerdict.acceptable) {
    planCriticAutoRevised = true;
    const currentParsed = parseExistingIssueFiles(repoRoot, slug);
    const fixNote = criticVerdict.problems.map((p) => p.fix).join('; ') || 'Refined slice boundary';
    draftIssues = writeNormalizedIssueList(
      repoRoot,
      slug,
      currentParsed.map((item, idx) => ({
        title: item.title,
        whatToBuild: `${item.whatToBuild}\n\nRevision note: ${fixNote}`,
        filesToRead: item.filesToRead,
        criteria: item.criteria,
        blockedByIndices: idx === 0 ? [] : [0],
      })),
    );

    if (params.roleDispatcher) {
      const secondDispatched = await params.roleDispatcher({
        role: 'plan-critic',
        repoRoot,
        slug,
        attempt: 2,
        prompt: `Re-audit revised draft issues for ${slug}`,
        context: { issues: draftIssues },
      });
      criticVerdict = {
        acceptable: Boolean(secondDispatched.acceptable),
        problems: (secondDispatched.problems as Array<{ problem: string; fix: string }>) ?? [],
        frontierErrors: (secondDispatched.frontierErrors as string[]) ?? [],
      };
    } else {
      criticVerdict = { acceptable: true, problems: [], frontierErrors: [] };
    }

    const secondCriticCheck = await runGantryScript(
      'result.py',
      ['--role', 'plan-critic', '--json'],
      {
        repoRoot,
        skillDir,
        input: JSON.stringify(criticVerdict),
      },
    );
    if (secondCriticCheck.exitCode !== 0) {
      throw new Error(`Plan Critic 2nd pass failed contract validation: ${secondCriticCheck.stdout}`);
    }
  }

  // Measure each draft Issue's Initial Context Budget via budget.py
  const auditedIssues: Array<{
    ref: string;
    title: string;
    path: string;
    blockedBy: string[];
    estimatedTokens: number;
    budgetTokens: number;
    overBudget: boolean;
  }> = [];

  for (const iss of draftIssues) {
    const budgetRes = await runGantryScript(
      'budget.py',
      [iss.path, '--model', 'anthropic/claude-opus-4-5', '--cwd', repoRoot, '--json'],
      { repoRoot, skillDir },
    );
    if (budgetRes.exitCode !== 0) {
      throw new Error(`budget.py failed for ${iss.path}: ${budgetRes.stderr || budgetRes.stdout}`);
    }
    const bJson = JSON.parse(budgetRes.stdout);
    auditedIssues.push({
      ref: iss.ref,
      title: iss.title,
      path: iss.path,
      blockedBy: iss.blockedBy,
      estimatedTokens: Number(bJson.estimatedTokens ?? 100),
      budgetTokens: Number(bJson.budgetTokens ?? 30000),
      overBudget: Boolean(bJson.overBudget),
    });
  }

  const anyOverBudget = auditedIssues.some((i) => i.overBudget);
  if (anyOverBudget) {
    criticVerdict = {
      acceptable: false,
      problems: [
        ...criticVerdict.problems,
        {
          problem: 'One or more draft Issues exceed Initial Context Budget',
          fix: 'Split over-budget Issues into smaller vertical slices',
        },
      ],
      frontierErrors: criticVerdict.frontierErrors,
    };
  }

  const waves: string[][] = auditedIssues.map((i) => [i.ref]);

  const decisionCard: DecisionCardPayload = {
    kind: 'plan_approval',
    slug,
    specPath: specRelPath,
    issues: auditedIssues,
    waves,
    criticVerdict: {
      acceptable: criticVerdict.acceptable,
      problems: criticVerdict.problems,
    },
  };

  store.updateProjectState(project.id, {
    lifecycleState: 'awaiting_plan_approval',
    badgeState: 'needs input',
  });

  const msg = store.appendMessage({
    projectId: project.id,
    sessionId,
    role: 'assistant',
    content: anyOverBudget
      ? `Plan for **${slug}** has Issues exceeding Initial Context Budget; please split or refine before approving.`
      : `Plan for **${slug}** is ready for approval (${auditedIssues.length} vertical slices, all within Initial Context Budget).`,
    decisionCard,
  });

  params.broadcast({
    type: 'plan.awaiting_approval',
    projectId: project.id,
    sessionId,
    slug,
    message: msg,
  });
  params.broadcast({
    type: 'alert.triggered',
    projectId: project.id,
    projectName: project.name,
    sessionId,
    messageId: msg.id,
    badgeState: 'needs input',
    cardKind: 'plan_approval',
  });

  return {
    specValidation,
    planCriticAutoRevised,
    decisionCard,
    messageId: msg.id,
  };
}

export async function answerGrillingRound(params: {
  project: RegisteredProject;
  store: HarnessStateStore;
  stateRoot: string;
  slug: string;
  runId: string;
  sessionId: string;
  roundNumber: number;
  answers: Record<string, string>;
  finishGrilling?: boolean;
  roleDispatcher?: RoleDispatcher;
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<Record<string, unknown>> {
  const { project, store, stateRoot, slug, runId, sessionId } = params;
  const repoRoot = path.resolve(project.path);
  const skillDir = resolveSkillDir(repoRoot).skillDir!;
  const issueRef = `${slug}#01`;

  const sessionState = activePlanSessions.get(`${project.id}:${slug}`) ?? {
    slug,
    goal: slug,
    runId,
    sessionId,
    roundNumber: params.roundNumber,
    answers: {},
  };
  sessionState.answers = { ...sessionState.answers, ...params.answers };
  activePlanSessions.set(`${project.id}:${slug}`, sessionState);

  // Mark previous grilling card resolved and broadcast resolution
  const existingMessages = store.listMessages(project.id, sessionId);
  for (const m of existingMessages) {
    if (m.decisionCard?.kind === 'grilling_round' && !m.decisionCard.resolved) {
      const resolvedMsg = store.resolveDecisionCard(m.id, params.answers);
      if (resolvedMsg) {
        params.broadcast({ type: 'decision_card.resolved', message: resolvedMsg });
      }
    }
  }

  await appendRunEvent({
    repoRoot,
    skillDir,
    stateRoot,
    unitId: project.unitId,
    runId,
    event: 'operator.approved',
    issue: issueRef,
  });

  // If operator wants another grilling round (`finishGrilling === false`), emit next round!
  if (params.finishGrilling === false) {
    const nextRoundNumber = params.roundNumber + 1;
    sessionState.roundNumber = nextRoundNumber;

    await appendRunEvent({
      repoRoot,
      skillDir,
      stateRoot,
      unitId: project.unitId,
      runId,
      event: 'phase.started',
      issue: issueRef,
      phase: 'Plan',
      data: { operatorWaiting: true },
    });

    const languagePolicy = resolveLanguagePolicy(repoRoot);
    const contextExplored = exploreRepositoryContext(repoRoot);
    const planGoalRes = await runGantryScript(
      'plan.py',
      ['--goal', sessionState.goal, '--json'],
      { repoRoot, skillDir },
    );
    const planGoalData =
      planGoalRes.exitCode === 0 ? JSON.parse(planGoalRes.stdout) : { phases: [] };

    const nextCard = buildLocalizedGrillingCard({
      slug,
      goal: sessionState.goal,
      roundNumber: nextRoundNumber,
      conversationLanguage: languagePolicy.conversationLanguage,
      glossaryTerms: contextExplored.glossaryTerms,
      sourceFiles: contextExplored.sourceFiles,
      planPhases: planGoalData.phases ?? [],
    });

    store.updateProjectState(project.id, {
      lifecycleState: 'grilling_interview',
      badgeState: 'needs input',
    });

    const msg = store.appendMessage({
      projectId: project.id,
      sessionId,
      role: 'assistant',
      content:
        languagePolicy.conversationLanguage === 'pt-BR'
          ? `Rodada ${nextRoundNumber} do Socratic Gate para **${slug}**:`
          : `Socratic Gate Round ${nextRoundNumber} for **${slug}**:`,
      decisionCard: nextCard,
    });

    params.broadcast({
      type: 'plan.grilling_round',
      projectId: project.id,
      sessionId,
      runId,
      slug,
      message: msg,
    });

    return {
      slug,
      runId,
      roundNumber: nextRoundNumber,
      decisionCard: nextCard,
      messageId: msg.id,
    };
  }

  // Synthesize canonical English Spec preserving original goal and all accumulated answers
  const specDir = path.join(repoRoot, '.scratch', slug);
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, 'spec.md');
  const specContent = buildCanonicalEnglishSpec(slug, sessionState.goal, sessionState.answers);
  fs.writeFileSync(specPath, specContent, 'utf-8');

  store.updateProjectState(project.id, {
    lifecycleState: 'spec_validation',
    badgeState: 'working',
  });

  const specRelPath = path.join('.scratch', slug, 'spec.md');
  const specCheckRes = await runGantryScript(
    'spec.py',
    [specRelPath, '--check', '--cwd', repoRoot, '--json'],
    { repoRoot, skillDir },
  );
  const specValidation = JSON.parse(specCheckRes.stdout);

  if (!specValidation.valid) {
    const findings = [
      ...(specValidation.missing ?? []).map((h: string) => ({
        quote: h,
        reason: `Missing required heading ${h}`,
      })),
      ...(specValidation.malformed_scenarios ?? []).map((s: { reason: string }) => ({
        quote: 'Scenario',
        reason: s.reason,
      })),
    ];
    const blockedCard: DecisionCardPayload = {
      kind: 'spec_blocked',
      slug,
      source: 'spec_structural_validation',
      findings:
        findings.length > 0 ? findings : [{ quote: specRelPath, reason: 'Invalid Spec structure' }],
    };
    store.updateProjectState(project.id, {
      lifecycleState: 'spec_validation',
      badgeState: 'blocked',
    });
    const msg = store.appendMessage({
      projectId: project.id,
      sessionId,
      role: 'assistant',
      content: `Spec structural validation reported blocking findings for **${slug}**.`,
      decisionCard: blockedCard,
    });
    params.broadcast({ type: 'plan.spec_blocked', projectId: project.id, slug, message: msg });
    params.broadcast({
      type: 'alert.triggered',
      projectId: project.id,
      projectName: project.name,
      sessionId,
      messageId: msg.id,
      badgeState: 'blocked',
      cardKind: 'spec_blocked',
    });
    return { specValidation, decisionCard: blockedCard, messageId: msg.id };
  }

  // Requirement Critic dispatch & validation via result.py --role requirement-critic --json
  let reqCriticPayload: {
    blocking: Array<{ quote: string; reason: string }>;
    findings: Array<{ quote: string; reason: string }>;
  } = {
    blocking: [],
    findings: [],
  };

  if (params.roleDispatcher) {
    const dispatched = await params.roleDispatcher({
      role: 'requirement-critic',
      repoRoot,
      slug,
      attempt: 1,
      prompt: `Review Spec ${specRelPath} for ambiguity and verifiability`,
      context: { specContent },
    });
    reqCriticPayload = {
      blocking: (dispatched.blocking as Array<{ quote: string; reason: string }>) ?? [],
      findings: (dispatched.findings as Array<{ quote: string; reason: string }>) ?? [],
    };
  }

  const reqCheck = await runGantryScript('result.py', ['--role', 'requirement-critic', '--json'], {
    repoRoot,
    skillDir,
    input: JSON.stringify(reqCriticPayload),
  });
  if (reqCheck.exitCode !== 0) {
    throw new Error(`Requirement critic contract failed: ${reqCheck.stdout}`);
  }

  if (reqCriticPayload.blocking.length > 0) {
    const blockedCard: DecisionCardPayload = {
      kind: 'spec_blocked',
      slug,
      source: 'requirement_critic',
      findings: reqCriticPayload.blocking,
    };
    store.updateProjectState(project.id, {
      lifecycleState: 'requirement_review',
      badgeState: 'blocked',
    });
    const msg = store.appendMessage({
      projectId: project.id,
      sessionId,
      role: 'assistant',
      content: `Requirement Critic identified blocking ambiguity in **${slug}**.`,
      decisionCard: blockedCard,
    });
    params.broadcast({ type: 'plan.spec_blocked', projectId: project.id, slug, message: msg });
    params.broadcast({
      type: 'alert.triggered',
      projectId: project.id,
      projectName: project.name,
      sessionId,
      messageId: msg.id,
      badgeState: 'blocked',
      cardKind: 'spec_blocked',
    });
    return { specValidation, decisionCard: blockedCard, messageId: msg.id };
  }

  return sliceAndCritiquePlan({
    project,
    store,
    slug,
    sessionId,
    roleDispatcher: params.roleDispatcher,
    broadcast: params.broadcast,
  });
}

export async function refineBlockedSpec(params: {
  project: RegisteredProject;
  store: HarnessStateStore;
  slug: string;
  sessionId: string;
  amendment: string;
  roleDispatcher?: RoleDispatcher;
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<Record<string, unknown>> {
  const { project, store, slug, sessionId } = params;
  const repoRoot = path.resolve(project.path);

  const existingMessages = store.listMessages(project.id, sessionId);
  for (const m of existingMessages) {
    if (m.decisionCard?.kind === 'spec_blocked' && !m.decisionCard.resolved) {
      const resolvedMsg = store.resolveDecisionCard(m.id, { amendment: params.amendment });
      if (resolvedMsg) {
        params.broadcast({ type: 'decision_card.resolved', message: resolvedMsg });
      }
    }
  }

  const sessionState = activePlanSessions.get(`${project.id}:${slug}`) ?? {
    slug,
    goal: slug,
    runId: '',
    sessionId,
    roundNumber: 1,
    answers: { Architecture: 'Deterministic HTTP endpoint' },
  };

  const specPath = path.join(repoRoot, '.scratch', slug, 'spec.md');
  const updatedSpec = buildCanonicalEnglishSpec(
    slug,
    sessionState.goal,
    sessionState.answers,
    params.amendment,
  );
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, updatedSpec, 'utf-8');

  return sliceAndCritiquePlan({
    project,
    store,
    slug,
    sessionId,
    roleDispatcher: params.roleDispatcher,
    broadcast: params.broadcast,
  });
}

export async function editDraftIssues(params: {
  project: RegisteredProject;
  store: HarnessStateStore;
  slug: string;
  sessionId: string;
  action: 'split' | 'merge' | 'reorder' | 'refine';
  targetRef?: string;
  instruction: string;
  roleDispatcher?: RoleDispatcher;
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<Record<string, unknown>> {
  const repoRoot = path.resolve(params.project.path);
  const existing = parseExistingIssueFiles(repoRoot, params.slug);
  const targetIdx = params.targetRef
    ? existing.findIndex((i) => i.ref === params.targetRef)
    : existing.length - 1;
  const effectiveIdx = targetIdx >= 0 ? targetIdx : Math.max(existing.length - 1, 0);

  if (existing.length > 0) {
    if (params.action === 'split') {
      const target = existing[effectiveIdx];
      const nextItems = existing.map((item, idx) => ({
        title: item.title,
        whatToBuild: item.whatToBuild,
        filesToRead: item.filesToRead,
        criteria: item.criteria,
        blockedByIndices: idx === 0 ? [] : [idx - 1],
      }));
      nextItems.splice(effectiveIdx + 1, 0, {
        title: params.instruction || `Split from ${target.ref}`,
        whatToBuild: `Vertical slice split from ${target.ref}: ${params.instruction}`,
        filesToRead: target.filesToRead,
        criteria: [`Verify ${params.instruction || 'split capability'}`],
        blockedByIndices: [effectiveIdx],
      });
      writeNormalizedIssueList(repoRoot, params.slug, nextItems);
    } else if (params.action === 'merge' && existing.length >= 2) {
      const mergeWithIdx = effectiveIdx > 0 ? effectiveIdx - 1 : 1;
      const keepIdx = Math.min(effectiveIdx, mergeWithIdx);
      const dropIdx = Math.max(effectiveIdx, mergeWithIdx);
      const merged = existing
        .filter((_, idx) => idx !== dropIdx)
        .map((item, idx) => {
          if (idx === keepIdx) {
            return {
              title: `${item.title} + ${existing[dropIdx].title}`,
              whatToBuild: `${item.whatToBuild}\n\nMerged: ${existing[dropIdx].whatToBuild}`,
              filesToRead: Array.from(new Set([...item.filesToRead, ...existing[dropIdx].filesToRead])),
              criteria: [...item.criteria, ...existing[dropIdx].criteria],
              blockedByIndices: idx === 0 ? [] : [idx - 1],
            };
          }
          return {
            title: item.title,
            whatToBuild: item.whatToBuild,
            filesToRead: item.filesToRead,
            criteria: item.criteria,
            blockedByIndices: idx === 0 ? [] : [idx - 1],
          };
        });
      writeNormalizedIssueList(repoRoot, params.slug, merged);
    } else if (params.action === 'reorder' && existing.length >= 2) {
      const copy = [...existing];
      if (effectiveIdx > 0) {
        const [picked] = copy.splice(effectiveIdx, 1);
        copy.splice(effectiveIdx - 1, 0, picked);
      }
      writeNormalizedIssueList(
        repoRoot,
        params.slug,
        copy.map((item, idx) => ({
          title: item.title,
          whatToBuild: item.whatToBuild,
          filesToRead: item.filesToRead,
          criteria: item.criteria,
          blockedByIndices: idx === 0 ? [] : [idx - 1],
        })),
      );
    } else {
      // refine
      writeNormalizedIssueList(
        repoRoot,
        params.slug,
        existing.map((item, idx) => ({
          title: idx === effectiveIdx ? `${item.title} (${params.instruction})` : item.title,
          whatToBuild:
            idx === effectiveIdx
              ? `${item.whatToBuild}\n\nRefinement: ${params.instruction}`
              : item.whatToBuild,
          filesToRead: item.filesToRead,
          criteria: item.criteria,
          blockedByIndices: idx === 0 ? [] : [idx - 1],
        })),
      );
    }
  }

  return sliceAndCritiquePlan({
    project: params.project,
    store: params.store,
    slug: params.slug,
    sessionId: params.sessionId,
    preserveExistingIssues: true,
    roleDispatcher: params.roleDispatcher,
    broadcast: params.broadcast,
  });
}

export async function approvePlan(params: {
  project: RegisteredProject;
  store: HarnessStateStore;
  stateRoot: string;
  slug: string;
  runId?: string;
  sessionId: string;
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<{
  approved: boolean;
  slug: string;
  readyIssues: string[];
  waves: Record<string, unknown>;
  roadmapCheck: Record<string, unknown>;
}> {
  const { project, store, stateRoot, slug, sessionId } = params;
  const repoRoot = path.resolve(project.path);
  const skillDir = resolveSkillDir(repoRoot).skillDir!;

  // Mark spec status as ready-for-agent
  const specPath = path.join(repoRoot, '.scratch', slug, 'spec.md');
  if (fs.existsSync(specPath)) {
    const specText = fs
      .readFileSync(specPath, 'utf-8')
      .replace(/^Status:\s*.+$/m, 'Status: ready-for-agent');
    fs.writeFileSync(specPath, specText, 'utf-8');
  }

  // Transition every draft issue via authoritative roadmap.py status <ref> ready-for-agent
  const issuesDir = path.join(repoRoot, '.scratch', slug, 'issues');
  const readyIssues: string[] = [];
  if (fs.existsSync(issuesDir)) {
    const files = fs.readdirSync(issuesDir).filter((f) => f.endsWith('.md')).sort();
    for (const file of files) {
      const numMatch = file.match(/^(\d+)/);
      const num = numMatch ? numMatch[1] : '01';
      const ref = `${slug}#${num}`;
      const statusRes = await runGantryScript('roadmap.py', ['status', ref, 'ready-for-agent'], {
        repoRoot,
        skillDir,
      });
      if (statusRes.exitCode !== 0) {
        throw new Error(
          `roadmap.py status failed for ${ref}: ${statusRes.stderr || statusRes.stdout}`,
        );
      }
      readyIssues.push(ref);
    }
  }

  // Ensure ROADMAP.md has Gantry's generated block markers without deleting existing content
  const roadmapPath = path.join(repoRoot, 'ROADMAP.md');
  const existingRoadmap = fs.existsSync(roadmapPath) ? fs.readFileSync(roadmapPath, 'utf-8') : '';
  if (
    !existingRoadmap.includes('<!-- BEGIN GENERATED: spec progress -->') ||
    !existingRoadmap.includes('<!-- BEGIN GENERATED: issue checklist -->')
  ) {
    const generatedSection = [
      existingRoadmap.trim() ? existingRoadmap.trimEnd() : '# Roadmap',
      '',
      '| Metric | Value |',
      '|---|---|',
      '| Issues completed | **0 / 0** |',
      '| Specs completed | **0 / 0** |',
      '| Execution waves | **0** |',
      '',
      '## Spec Progress',
      '',
      '<!-- BEGIN GENERATED: spec progress -->',
      '<!-- END GENERATED: spec progress -->',
      '',
      '## Issue Checklist',
      '',
      '<!-- BEGIN GENERATED: issue checklist -->',
      '<!-- END GENERATED: issue checklist -->',
      '',
    ].join('\n');
    fs.writeFileSync(roadmapPath, generatedSection, 'utf-8');
  }

  const wavesRes = await runGantryScript('roadmap.py', ['waves', '--json'], {
    repoRoot,
    skillDir,
  });
  if (wavesRes.exitCode !== 0) {
    throw new Error(`roadmap.py waves failed: ${wavesRes.stderr || wavesRes.stdout}`);
  }
  const waves = JSON.parse(wavesRes.stdout);

  const checkRes = await runGantryScript('roadmap.py', ['check', '--json'], {
    repoRoot,
    skillDir,
  });
  if (checkRes.exitCode !== 0) {
    throw new Error(`roadmap.py check failed: ${checkRes.stderr || checkRes.stdout}`);
  }
  const roadmapCheck = JSON.parse(checkRes.stdout);
  if (Array.isArray(roadmapCheck.drift) && roadmapCheck.drift.length > 0) {
    throw new Error(`ROADMAP.md drift detected after waves update: ${roadmapCheck.drift.join(', ')}`);
  }

  if (params.runId) {
    await appendRunEvent({
      repoRoot,
      skillDir,
      stateRoot,
      unitId: project.unitId,
      runId: params.runId,
      event: 'operator.approved',
      issue: `${slug}#01`,
    });
    await appendRunEvent({
      repoRoot,
      skillDir,
      stateRoot,
      unitId: project.unitId,
      runId: params.runId,
      event: 'phase.finished',
      issue: `${slug}#01`,
      phase: 'Plan',
    });
  }

  for (const m of store.listMessages(project.id, sessionId)) {
    if (m.decisionCard?.kind === 'plan_approval' && !m.decisionCard.resolved) {
      const resolvedMsg = store.resolveDecisionCard(m.id, { approved: true });
      if (resolvedMsg) {
        params.broadcast({ type: 'decision_card.resolved', message: resolvedMsg });
      }
    }
  }

  store.updateProjectState(project.id, {
    lifecycleState: 'idle',
    badgeState: 'idle',
  });

  params.broadcast({
    type: 'plan.approved',
    projectId: project.id,
    slug,
    readyIssues,
  });

  return {
    approved: true,
    slug,
    readyIssues,
    waves,
    roadmapCheck,
  };
}
