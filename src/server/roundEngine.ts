import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveSkillDir, runCommand, runGantryScript } from './commandRunner.js';
import type { RoleDispatcher } from './aiService.js';
import type { HarnessStateStore } from './stateStore.js';
import type { PtySupervisor } from './ptyManager.js';
import type { DecisionCardPayload, RegisteredProject } from '../types.js';

interface ActiveRunContext {
  runId: string;
  projectId: string;
  scope: string;
  sessionId: string;
  runBranch: string;
  targetBranch: string;
  worktreesByIssue: Record<string, { worktreePath: string; branch: string }>;
  queuedSteeringByIssue: Record<string, string[]>;
  immediateSteeringByIssue: Record<string, string[]>;
  issueRoleOverrides: Record<
    string,
    Record<string, { harness: string; model: string; effort?: string }>
  >;
  pausedPhaseByIssue: Record<string, 'Implement' | 'Review' | 'Critic'>;
  operatorTakeoverByIssue: Record<string, boolean>;
  criticEvidenceByIssue: Record<string, string[]>;
  cleanupPlanJson?: Record<string, unknown>;
}

const activeRunContexts = new Map<string, ActiveRunContext>();

/**
 * Projects Critic result for `runlog.py append` per `reference/round-workflow.md`:
 * Narrows `gateResult` to `{ verdict, requirements }` and drops `gates` so `runlog.py`
 * never rejects `command` or `output_tail` tokens.
 */
export function projectCriticResult(verdict: Record<string, unknown>): Record<string, unknown> {
  const gateResultRaw = (verdict.gateResult ?? {}) as Record<string, unknown>;
  return {
    complete: Boolean(verdict.complete),
    criteria: verdict.criteria ?? [],
    gatesVerdict: verdict.gatesVerdict ?? 'pass',
    gateResult: {
      verdict: gateResultRaw.verdict ?? verdict.gatesVerdict ?? 'pass',
      requirements: gateResultRaw.requirements ?? [],
    },
    gateFailures: verdict.gateFailures ?? [],
    refutations: verdict.refutations ?? [],
    requiredFixes: verdict.requiredFixes ?? [],
    decisionsForOperator: verdict.decisionsForOperator ?? [],
  };
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
  broadcast?: (evt: Record<string, unknown>) => void;
}): Promise<void> {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    run: options.runId,
    event: options.event,
  };
  if (options.issue) payload.issue = options.issue;
  if (options.phase) payload.phase = options.phase;
  if (options.data) payload.data = options.data;

  const res = await runGantryScript(
    'runlog.py',
    ['append', options.unitId, options.runId, '--state-root', options.stateRoot],
    {
      repoRoot: options.repoRoot,
      skillDir: options.skillDir,
      input: JSON.stringify(payload),
    },
  );
  if (res.exitCode !== 0) {
    throw new Error(`runlog.py append failed for ${options.event}: ${res.stderr || res.stdout}`);
  }
  if (options.broadcast) {
    options.broadcast({
      type: 'runlog.event',
      unitId: options.unitId,
      runId: options.runId,
      event: payload,
    });
  }
}

async function dispatchAndValidateRole(params: {
  role: 'implementer' | 'reviewer' | 'critic' | 'learner';
  repoRoot: string;
  skillDir: string;
  unitId: string;
  runId: string;
  stateRoot: string;
  slug: string;
  issueRef: string;
  prompt: string;
  selection: { harness: string; model: string; effort?: string };
  context: Record<string, unknown>;
  roleDispatcher?: RoleDispatcher;
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<Record<string, unknown>> {
  const {
    role,
    repoRoot,
    skillDir,
    unitId,
    runId,
    stateRoot,
    slug,
    issueRef,
    prompt,
    selection,
    context,
    roleDispatcher,
    broadcast,
  } = params;

  const policyRoleKey =
    role === 'implementer' ? 'implement' : role === 'reviewer' ? 'review' : role;

  for (let attempt = 1; attempt <= 2; attempt++) {
    broadcast({
      type: 'role.stream.started',
      runId,
      issueRef,
      role,
      attempt,
      selection,
    });

    let candidate: Record<string, unknown>;
    if (roleDispatcher) {
      candidate = await roleDispatcher({
        role,
        repoRoot,
        slug,
        issueRef,
        attempt,
        prompt,
        context: {
          ...context,
          selection,
        },
      });
    } else {
      // Production path: dispatch through Gantry's execution.py dispatch
      const dispatchRes = await runGantryScript(
        'execution.py',
        [
          'dispatch',
          '--role',
          policyRoleKey,
          '--prompt',
          prompt,
          '--cwd',
          String(context.worktreePath ?? repoRoot),
          '--selection',
          JSON.stringify(selection),
          '--run-id',
          runId,
          '--unit-id',
          unitId,
          '--state-root',
          stateRoot,
          '--issue-ref',
          issueRef,
          '--json',
        ],
        { repoRoot, skillDir },
      );
      if (dispatchRes.exitCode !== 0) {
        throw new Error(
          `Execution failure for role ${role}: ${dispatchRes.stderr || dispatchRes.stdout}`,
        );
      }
      candidate = JSON.parse(dispatchRes.stdout) as Record<string, unknown>;
    }

    const checkRes = await runGantryScript('result.py', ['--role', role, '--json'], {
      repoRoot,
      skillDir,
      input: JSON.stringify(candidate),
    });
    if (checkRes.exitCode === 0) {
      const parsedCheck = JSON.parse(checkRes.stdout);
      if (parsedCheck.valid) {
        broadcast({
          type: 'role.stream.finished',
          runId,
          issueRef,
          role,
          attempt,
          selection,
        });
        return candidate;
      }
    }
    if (attempt === 2) {
      throw new Error(`Protocol Failure: ${role} result failed contract validation after retry`);
    }
  }
  throw new Error(`Unreachable dispatch state for ${role}`);
}

async function emitRecoveryCard(params: {
  project: RegisteredProject;
  store: HarnessStateStore;
  repoRoot: string;
  skillDir: string;
  stateRoot: string;
  runId: string;
  issueRef: string;
  worktreePath: string;
  phase: 'Implement' | 'Review' | 'Critic';
  roleKey: string;
  failureReason:
    | 'execution_unavailable'
    | 'verification_unavailable'
    | 'correction_budget_exhausted'
    | 'preflight_failed';
  currentSelection: { harness: string; model: string; effort?: string };
  sessionId: string;
  errorText: string;
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<Record<string, unknown>> {
  const {
    project,
    store,
    repoRoot,
    skillDir,
    stateRoot,
    runId,
    issueRef,
    worktreePath,
    phase,
    roleKey,
    failureReason,
    currentSelection,
    sessionId,
    errorText,
    broadcast,
  } = params;

  const runCtx = activeRunContexts.get(runId);
  if (runCtx) {
    runCtx.pausedPhaseByIssue[issueRef] = phase;
  }

  if (failureReason === 'execution_unavailable' || failureReason === 'verification_unavailable') {
    await appendRunEvent({
      repoRoot,
      skillDir,
      stateRoot,
      unitId: project.unitId,
      runId,
      event: 'issue.paused',
      issue: issueRef,
      phase,
      data: {
        role: roleKey,
        reason: failureReason,
      },
      broadcast,
    });
  }

  const corrRes = await runGantryScript(
    'runlog.py',
    ['corrections', project.unitId, runId, issueRef, '--state-root', stateRoot, '--json'],
    { repoRoot, skillDir },
  );
  const correctionsSpent =
    corrRes.exitCode === 0 ? Number(JSON.parse(corrRes.stdout).correctionsSpent ?? 0) : 0;

  const recoveryCard: DecisionCardPayload = {
    kind: 'issue_recovery',
    runId,
    issueRef,
    worktree: worktreePath,
    failureReason,
    correctionsSpent,
    currentSelection,
    availableReplacements: [
      { harness: 'opencode', model: 'openai/gpt-5.2-codex' },
      { harness: 'opencode', model: 'anthropic/claude-opus-4-5' },
      { harness: 'codex', model: 'gpt-5.2-codex', effort: 'high' },
    ],
  };

  store.updateProjectState(project.id, {
    lifecycleState: 'awaiting_recovery_decision',
    badgeState: 'blocked',
  });

  const msg = store.appendMessage({
    projectId: project.id,
    sessionId,
    role: 'assistant',
    content: `Issue **${issueRef}** paused in phase **${phase}** (${failureReason}). Select an \`issueRoleReplacement\` to resume.`,
    decisionCard: recoveryCard,
  });

  broadcast({
    type: 'run.issue_paused',
    projectId: project.id,
    runId,
    issueRef,
    phase,
    message: msg,
  });
  broadcast({
    type: 'alert.triggered',
    projectId: project.id,
    projectName: project.name,
    sessionId,
    messageId: msg.id,
    badgeState: 'blocked',
    cardKind: 'issue_recovery',
  });

  return {
    status: 'paused',
    runId,
    issueRef,
    phase,
    decisionCard: recoveryCard,
    messageId: msg.id,
    error: errorText,
  };
}

export async function executeRunWorkflow(params: {
  project: RegisteredProject;
  store: HarnessStateStore;
  stateRoot: string;
  profileRoot: string;
  scope: string;
  sessionId: string;
  priorRunId?: string;
  resumeIssueRef?: string;
  resumePhase?: 'Implement' | 'Review' | 'Critic';
  roleDispatcher?: RoleDispatcher;
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<Record<string, unknown>> {
  const { project, store, stateRoot, profileRoot, scope, sessionId, broadcast } = params;
  const repoRoot = path.resolve(project.path);
  const skillDir = resolveSkillDir(repoRoot).skillDir;
  if (!skillDir) {
    throw new Error('Gantry skill pack not found');
  }

  store.updateProjectState(project.id, {
    lifecycleState: 'round_preflight',
    badgeState: 'working',
  });

  // 1. Preflight: verify clean working tree
  const gitStatus = await runCommand(['git', 'status', '--porcelain'], { cwd: repoRoot });
  if (gitStatus.stdout.trim().length > 0) {
    throw new Error('Preflight refused: repository has a dirty working tree.');
  }

  // 2. Resolve policy & roles
  const commonRes = await runGantryScript('common.py', ['--cwd', repoRoot, '--json'], {
    repoRoot,
    skillDir,
    env: { GANTRY_PROFILE_ROOT: profileRoot },
  });
  const commonData = commonRes.exitCode === 0 ? JSON.parse(commonRes.stdout) : { policy: {} };
  const policy = (commonData.policy ?? {}) as Record<string, unknown>;
  const execPolicy = (policy.execution ?? {}) as Record<string, unknown>;
  const confirmedHost = String(execPolicy.hostHarness ?? 'opencode');
  const maxCorrections = Number(
    ((policy.budget as Record<string, unknown>)?.corrections as number | undefined) ?? 2,
  );

  // 3. Query inflight Runs via runlog.py inflight
  const inflightRes = await runGantryScript(
    'runlog.py',
    ['inflight', project.unitId, '--state-root', stateRoot, '--json'],
    { repoRoot, skillDir },
  );
  const inflightData =
    inflightRes.exitCode === 0 ? JSON.parse(inflightRes.stdout) : { inflight: [] };

  // 4. Resolve Host Harness via execution.py host --require-resolved --host <confirmedHost>
  const hostArgs = [
    'host',
    '--require-resolved',
    '--host',
    confirmedHost,
    '--cwd',
    repoRoot,
    '--profile-root',
    profileRoot,
    '--json',
  ];
  const hostRes = await runGantryScript('execution.py', hostArgs, { repoRoot, skillDir });
  if (hostRes.exitCode !== 0) {
    throw new Error(`Host resolution failed: ${hostRes.stderr || hostRes.stdout}`);
  }

  // 5. Run selected-profile preflight via execution.py preflight (skip slow binary version probe when roleDispatcher double is injected)
  let preflightJson: Record<string, unknown> = { valid: true };
  if (!params.roleDispatcher) {
    const preflightRes = await runGantryScript(
      'execution.py',
      ['preflight', '--cwd', repoRoot, '--json'],
      { repoRoot, skillDir, env: { GANTRY_PROFILE_ROOT: profileRoot } },
    );
    preflightJson =
      preflightRes.stdout.trim() ? JSON.parse(preflightRes.stdout) : { valid: true };
  }

  // Resolve roles via execution.py resolve
  const resolveRolesRes = await runGantryScript(
    'execution.py',
    ['resolve', '--cwd', repoRoot, '--json'],
    { repoRoot, skillDir, env: { GANTRY_PROFILE_ROOT: profileRoot } },
  );
  const baseRoles: Record<string, { harness: string; model: string; effort?: string }> =
    resolveRolesRes.exitCode === 0 ? JSON.parse(resolveRolesRes.stdout) : {};

  // 6. Compute dependency rounds exclusively via frontier.py
  const frontierRes = await runGantryScript('frontier.py', ['--scope', scope, '--json'], {
    repoRoot,
    skillDir,
  });
  if (frontierRes.exitCode !== 0) {
    throw new Error(`frontier.py failed: ${frontierRes.stderr || frontierRes.stdout}`);
  }
  const frontier = JSON.parse(frontierRes.stdout) as {
    rounds: string[][];
    selected: string[];
  };

  const runId = params.priorRunId ?? `run-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
  const isResumed = Boolean(params.priorRunId);

  const gitPolicy = (policy.git ?? {}) as Record<string, string>;
  const targetBranch = gitPolicy.target ?? 'main';
  const branchPrefix = gitPolicy.prefix ?? 'gantry/';
  const runBranch = `${branchPrefix}run-${scope}`;

  // Ensure we are on the dedicated Run branch (never committing directly to targetBranch without a Run branch)
  const curBranchRes = await runCommand(['git', 'branch', '--show-current'], { cwd: repoRoot });
  if (curBranchRes.stdout.trim() !== runBranch) {
    await runCommand(['git', 'checkout', '-B', runBranch], { cwd: repoRoot });
  }

  let runCtx = activeRunContexts.get(runId);
  if (!runCtx) {
    runCtx = {
      runId,
      projectId: project.id,
      scope,
      sessionId,
      runBranch,
      targetBranch,
      worktreesByIssue: {},
      queuedSteeringByIssue: {},
      immediateSteeringByIssue: {},
      issueRoleOverrides: {},
      pausedPhaseByIssue: {},
      operatorTakeoverByIssue: {},
      criticEvidenceByIssue: {},
    };
    activeRunContexts.set(runId, runCtx);
  }

  if (!isResumed) {
    await appendRunEvent({
      repoRoot,
      skillDir,
      stateRoot,
      unitId: project.unitId,
      runId,
      event: 'run.started',
      data: {
        repositoryRoot: repoRoot,
        policyHash: crypto
          .createHash('sha256')
          .update(JSON.stringify(policy))
          .digest('hex')
          .slice(0, 12),
        tier: 'supported',
        staleAfterSeconds: 900,
        inflightDetected: (inflightData.inflight ?? []).length,
        preflightValid: Boolean(preflightJson.valid),
      },
      broadcast,
    });
  } else {
    await appendRunEvent({
      repoRoot,
      skillDir,
      stateRoot,
      unitId: project.unitId,
      runId,
      event: 'run.resumed',
      broadcast,
    });
  }

  store.updateProjectState(project.id, {
    lifecycleState: 'round_executing',
    badgeState: 'working',
  });

  const completedIssues: string[] = [];
  const worktreesBaseDir = path.join(path.dirname(repoRoot), `.gantry-wt-${project.unitId}`);
  fs.mkdirSync(worktreesBaseDir, { recursive: true });

  for (let rIdx = 0; rIdx < frontier.rounds.length; rIdx++) {
    const roundIssues = frontier.rounds[rIdx];
    const roundNumber = rIdx + 1;

    await appendRunEvent({
      repoRoot,
      skillDir,
      stateRoot,
      unitId: project.unitId,
      runId,
      event: 'round.started',
      data: { round: roundNumber },
      broadcast,
    });

    let roundHadFailureOrBlock = false;

    for (const issueRef of roundIssues) {
      const getEffectiveSelection = (
        roleKey: 'implement' | 'review' | 'critic' | 'learner',
      ): { harness: string; model: string; effort?: string } => {
        return (
          runCtx!.issueRoleOverrides[issueRef]?.[roleKey] ??
          baseRoles[roleKey] ?? {
            harness: confirmedHost,
            model: 'anthropic/claude-opus-4-5',
          }
        );
      };

      // Check pre-existing spent corrections via runlog.py corrections
      const initialCorrRes = await runGantryScript(
        'runlog.py',
        ['corrections', project.unitId, runId, issueRef, '--state-root', stateRoot, '--json'],
        { repoRoot, skillDir },
      );
      const initialCorrectionsSpent =
        initialCorrRes.exitCode === 0
          ? Number(JSON.parse(initialCorrRes.stdout).correctionsSpent ?? 0)
          : 0;
      if (initialCorrectionsSpent >= maxCorrections) {
        return emitRecoveryCard({
          project,
          store,
          repoRoot,
          skillDir,
          stateRoot,
          runId,
          issueRef,
          worktreePath: runCtx.worktreesByIssue[issueRef]?.worktreePath ?? repoRoot,
          phase: 'Critic',
          roleKey: 'critic',
          failureReason: 'correction_budget_exhausted',
          currentSelection: getEffectiveSelection('critic'),
          sessionId,
          errorText: `Correction budget (${maxCorrections}) already exhausted for ${issueRef}`,
          broadcast,
        });
      }

      // Resolve canonical issue branch via common.py --issue <issueRef> --json
      const branchRes = await runGantryScript(
        'common.py',
        ['--cwd', repoRoot, '--issue', issueRef, '--json'],
        { repoRoot, skillDir },
      );
      const branchData = branchRes.exitCode === 0 ? JSON.parse(branchRes.stdout) : {};
      const issueBranch = String(
        branchData.issueBranch ?? `${branchPrefix}${issueRef.replace('#', '-')}`,
      );

      let wtEntry = runCtx.worktreesByIssue[issueRef];
      if (!wtEntry || !fs.existsSync(wtEntry.worktreePath)) {
        const wtPath = path.join(worktreesBaseDir, issueRef.replace(/[^a-zA-Z0-9_-]/g, '-'));
        if (!fs.existsSync(wtPath)) {
          await runCommand(['git', 'worktree', 'add', '-B', issueBranch, wtPath, 'HEAD'], {
            cwd: repoRoot,
          });
        }
        wtEntry = { worktreePath: wtPath, branch: issueBranch };
        runCtx.worktreesByIssue[issueRef] = wtEntry;
      }

      await runGantryScript(
        'runlog.py',
        ['mark', runId, '--cwd', wtEntry.worktreePath, '--state-root', stateRoot],
        { repoRoot: wtEntry.worktreePath, skillDir },
      );

      const startFromPhase =
        isResumed && params.resumeIssueRef === issueRef
          ? (params.resumePhase ?? runCtx.pausedPhaseByIssue[issueRef] ?? 'Implement')
          : 'Implement';

      const consumeSteeringSuffix = (): string => {
        const immediate = runCtx!.immediateSteeringByIssue[issueRef] ?? [];
        const queued = runCtx!.queuedSteeringByIssue[issueRef] ?? [];
        runCtx!.immediateSteeringByIssue[issueRef] = [];
        runCtx!.queuedSteeringByIssue[issueRef] = [];
        const combined = [...immediate, ...queued];
        return combined.length > 0 ? `\nOperator Steering: ${combined.join('\n')}` : '';
      };

      // Phase 1: Implement (unless resuming directly into Review or Critic)
      if (startFromPhase === 'Implement') {
        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'phase.started',
          issue: issueRef,
          phase: 'Implement',
          data: isResumed ? { recovery: true } : undefined,
          broadcast,
        });
        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'subagent.started',
          issue: issueRef,
          phase: 'Implement',
          data: { role: 'implementer' },
          broadcast,
        });

        const implSelection = getEffectiveSelection('implement');
        let implResult: Record<string, unknown>;
        try {
          implResult = await dispatchAndValidateRole({
            role: 'implementer',
            repoRoot,
            skillDir,
            unitId: project.unitId,
            runId,
            stateRoot,
            slug: scope,
            issueRef,
            prompt: `Implement ${issueRef} with TDD.${consumeSteeringSuffix()}`,
            selection: implSelection,
            context: {
              worktreePath: wtEntry.worktreePath,
              branch: wtEntry.branch,
            },
            roleDispatcher: params.roleDispatcher,
            broadcast,
          });
        } catch (err) {
          return emitRecoveryCard({
            project,
            store,
            repoRoot,
            skillDir,
            stateRoot,
            runId,
            issueRef,
            worktreePath: wtEntry.worktreePath,
            phase: 'Implement',
            roleKey: 'implement',
            failureReason: 'execution_unavailable',
            currentSelection: implSelection,
            sessionId,
            errorText: err instanceof Error ? err.message : 'Implementer failed',
            broadcast,
          });
        }

        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'subagent.stopped',
          issue: issueRef,
          phase: 'Implement',
          data: { role: 'implementer', result: implResult },
          broadcast,
        });
        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'phase.finished',
          issue: issueRef,
          phase: 'Implement',
          broadcast,
        });
      }

      // Phase 2: Review (plus 1 review-fix Implementer pass if blocking findings exist)
      if (startFromPhase === 'Implement' || startFromPhase === 'Review') {
        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'phase.started',
          issue: issueRef,
          phase: 'Review',
          broadcast,
        });
        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'subagent.started',
          issue: issueRef,
          phase: 'Review',
          data: { role: 'reviewer' },
          broadcast,
        });

        const reviewSelection = getEffectiveSelection('review');
        let reviewResult: Record<string, unknown>;
        try {
          reviewResult = await dispatchAndValidateRole({
            role: 'reviewer',
            repoRoot,
            skillDir,
            unitId: project.unitId,
            runId,
            stateRoot,
            slug: scope,
            issueRef,
            prompt: `Review ${issueRef} against standards and Spec.${consumeSteeringSuffix()}`,
            selection: reviewSelection,
            context: { worktreePath: wtEntry.worktreePath, branch: wtEntry.branch },
            roleDispatcher: params.roleDispatcher,
            broadcast,
          });
        } catch (err) {
          return emitRecoveryCard({
            project,
            store,
            repoRoot,
            skillDir,
            stateRoot,
            runId,
            issueRef,
            worktreePath: wtEntry.worktreePath,
            phase: 'Review',
            roleKey: 'review',
            failureReason: 'execution_unavailable',
            currentSelection: reviewSelection,
            sessionId,
            errorText: err instanceof Error ? err.message : 'Reviewer failed',
            broadcast,
          });
        }

        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'subagent.stopped',
          issue: issueRef,
          phase: 'Review',
          data: { role: 'reviewer', result: reviewResult },
          broadcast,
        });

        const blockingFindings = (reviewResult.blocking as Array<{ finding: string; fix: string }>) ?? [];
        const nonBlockingFindings = (reviewResult.nonBlocking as unknown[]) ?? [];
        if (blockingFindings.length > 0 || nonBlockingFindings.length > 0) {
          await appendRunEvent({
            repoRoot,
            skillDir,
            stateRoot,
            unitId: project.unitId,
            runId,
            event: 'review.finding',
            issue: issueRef,
            phase: 'Review',
            data: {
              blockingCount: blockingFindings.length,
              nonBlockingCount: nonBlockingFindings.length,
            },
            broadcast,
          });
        }

        // One review-fix implementer pass when Reviewer reports blocking findings
        if (blockingFindings.length > 0) {
          const fixSummary = blockingFindings.map((b) => `${b.finding}: ${b.fix}`).join('; ');
          await appendRunEvent({
            repoRoot,
            skillDir,
            stateRoot,
            unitId: project.unitId,
            runId,
            event: 'subagent.started',
            issue: issueRef,
            phase: 'Review',
            data: { role: 'implementer' },
            broadcast,
          });
          const reviewFixResult = await dispatchAndValidateRole({
            role: 'implementer',
            repoRoot,
            skillDir,
            unitId: project.unitId,
            runId,
            stateRoot,
            slug: scope,
            issueRef,
            prompt: `Fix blocking review findings for ${issueRef}: ${fixSummary}${consumeSteeringSuffix()}`,
            selection: getEffectiveSelection('implement'),
            context: { worktreePath: wtEntry.worktreePath, branch: wtEntry.branch, reviewFix: true },
            roleDispatcher: params.roleDispatcher,
            broadcast,
          });
          await appendRunEvent({
            repoRoot,
            skillDir,
            stateRoot,
            unitId: project.unitId,
            runId,
            event: 'subagent.stopped',
            issue: issueRef,
            phase: 'Review',
            data: { role: 'implementer', result: reviewFixResult },
            broadcast,
          });
        }

        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'phase.finished',
          issue: issueRef,
          phase: 'Review',
          broadcast,
        });
      }

      // Phase 3: Adversarial Critic + Correction Budget Loop
      let criticAccepted = false;
      while (!criticAccepted) {
        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'phase.started',
          issue: issueRef,
          phase: 'Critic',
          broadcast,
        });
        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'subagent.started',
          issue: issueRef,
          phase: 'Critic',
          data: { role: 'critic' },
          broadcast,
        });

        const criticSelection = getEffectiveSelection('critic');
        let criticRaw: Record<string, unknown>;
        try {
          criticRaw = await dispatchAndValidateRole({
            role: 'critic',
            repoRoot,
            skillDir,
            unitId: project.unitId,
            runId,
            stateRoot,
            slug: scope,
            issueRef,
            prompt: `Adversarially verify ${issueRef}.${consumeSteeringSuffix()}`,
            selection: criticSelection,
            context: { worktreePath: wtEntry.worktreePath, branch: wtEntry.branch },
            roleDispatcher: params.roleDispatcher,
            broadcast,
          });
        } catch (err) {
          return emitRecoveryCard({
            project,
            store,
            repoRoot,
            skillDir,
            stateRoot,
            runId,
            issueRef,
            worktreePath: wtEntry.worktreePath,
            phase: 'Critic',
            roleKey: 'critic',
            failureReason: 'verification_unavailable',
            currentSelection: criticSelection,
            sessionId,
            errorText: err instanceof Error ? err.message : 'Critic failed',
            broadcast,
          });
        }

        const projectedCritic = projectCriticResult(criticRaw);
        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'subagent.stopped',
          issue: issueRef,
          phase: 'Critic',
          data: { role: 'critic', result: projectedCritic },
          broadcast,
        });
        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'phase.finished',
          issue: issueRef,
          phase: 'Critic',
          broadcast,
        });

        if (projectedCritic.complete) {
          criticAccepted = true;
          const criteriaArr = (projectedCritic.criteria as Array<{ evidence?: string }>) ?? [];
          runCtx.criticEvidenceByIssue[issueRef] = criteriaArr
            .map((c) => c.evidence ?? '')
            .filter(Boolean);
          break;
        }

        // Critic refuted! Append refutation and check correction budget via runlog.py corrections
        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'refutation',
          issue: issueRef,
          phase: 'Critic',
          data: { refutations: projectedCritic.refutations },
          broadcast,
        });

        const corrRes = await runGantryScript(
          'runlog.py',
          ['corrections', project.unitId, runId, issueRef, '--state-root', stateRoot, '--json'],
          { repoRoot, skillDir },
        );
        const spent =
          corrRes.exitCode === 0 ? Number(JSON.parse(corrRes.stdout).correctionsSpent ?? 0) : 0;

        if (spent >= maxCorrections) {
          await appendRunEvent({
            repoRoot,
            skillDir,
            stateRoot,
            unitId: project.unitId,
            runId,
            event: 'issue.blocked',
            issue: issueRef,
            phase: 'Critic',
            broadcast,
          });
          roundHadFailureOrBlock = true;
          return emitRecoveryCard({
            project,
            store,
            repoRoot,
            skillDir,
            stateRoot,
            runId,
            issueRef,
            worktreePath: wtEntry.worktreePath,
            phase: 'Critic',
            roleKey: 'implement',
            failureReason: 'correction_budget_exhausted',
            currentSelection: getEffectiveSelection('implement'),
            sessionId,
            errorText: `Correction budget (${maxCorrections}) exhausted for ${issueRef}`,
            broadcast,
          });
        }

        // Run a correction Implement pass (starting `phase.started` for `Implement` without `recovery: true` increments `runlog.py corrections`!)
        const refutationSummary = (
          (projectedCritic.requiredFixes as string[]) ??
          (projectedCritic.refutations as string[]) ??
          []
        ).join('; ');
        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'phase.started',
          issue: issueRef,
          phase: 'Implement',
          broadcast,
        });
        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'subagent.started',
          issue: issueRef,
          phase: 'Implement',
          data: { role: 'implementer' },
          broadcast,
        });
        const corrImplResult = await dispatchAndValidateRole({
          role: 'implementer',
          repoRoot,
          skillDir,
          unitId: project.unitId,
          runId,
          stateRoot,
          slug: scope,
          issueRef,
          prompt: `Correction pass for ${issueRef}: ${refutationSummary}${consumeSteeringSuffix()}`,
          selection: getEffectiveSelection('implement'),
          context: { worktreePath: wtEntry.worktreePath, branch: wtEntry.branch, correctionPass: true },
          roleDispatcher: params.roleDispatcher,
          broadcast,
        });
        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'subagent.stopped',
          issue: issueRef,
          phase: 'Implement',
          data: { role: 'implementer', result: corrImplResult },
          broadcast,
        });
        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'phase.finished',
          issue: issueRef,
          phase: 'Implement',
          broadcast,
        });
      }

      // Verify Issue Worktree is clean before serial integration
      const wtStatus = await runCommand(['git', 'status', '--porcelain'], {
        cwd: wtEntry.worktreePath,
      });
      if (wtStatus.stdout.trim().length > 0) {
        throw new Error(`Refusing integration: worktree for ${issueRef} has uncommitted changes`);
      }

      // Phase 4: Serial Integration into Run branch
      await appendRunEvent({
        repoRoot,
        skillDir,
        stateRoot,
        unitId: project.unitId,
        runId,
        event: 'phase.started',
        issue: issueRef,
        phase: 'Integrate',
        broadcast,
      });

      const mergeRes = await runCommand(
        ['git', 'merge', '--no-ff', wtEntry.branch, '-m', `Integrate ${issueRef}`],
        { cwd: repoRoot },
      );
      if (mergeRes.exitCode !== 0) {
        throw new Error(`Serial merge failed for ${issueRef}: ${mergeRes.stderr}`);
      }

      const gatesRes = await runGantryScript('gates.py', ['--cwd', repoRoot, '--run', '--json'], {
        repoRoot,
        skillDir,
      });
      const gatesData = gatesRes.stdout.trim()
        ? (JSON.parse(gatesRes.stdout) as { verdict?: string })
        : { verdict: 'fail' };
      if (gatesData.verdict === 'fail') {
        await appendRunEvent({
          repoRoot,
          skillDir,
          stateRoot,
          unitId: project.unitId,
          runId,
          event: 'run.cancelled',
          broadcast,
        });
        throw new Error(`Post-merge gate failed after integrating ${issueRef}`);
      }

      const doneRes = await runGantryScript('roadmap.py', ['done', issueRef], {
        repoRoot,
        skillDir,
      });
      if (doneRes.exitCode !== 0) {
        throw new Error(
          `roadmap.py done failed for ${issueRef}: ${doneRes.stderr || doneRes.stdout}`,
        );
      }

      await runCommand(['git', 'add', '.'], { cwd: repoRoot });
      await runCommand(['git', 'commit', '-m', `Mark ${issueRef} done in roadmap`], {
        cwd: repoRoot,
      });

      await appendRunEvent({
        repoRoot,
        skillDir,
        stateRoot,
        unitId: project.unitId,
        runId,
        event: 'issue.done',
        issue: issueRef,
        phase: 'Integrate',
        broadcast,
      });
      await appendRunEvent({
        repoRoot,
        skillDir,
        stateRoot,
        unitId: project.unitId,
        runId,
        event: 'phase.finished',
        issue: issueRef,
        phase: 'Integrate',
        broadcast,
      });

      delete runCtx.pausedPhaseByIssue[issueRef];
      completedIssues.push(issueRef);
    }

    await appendRunEvent({
      repoRoot,
      skillDir,
      stateRoot,
      unitId: project.unitId,
      runId,
      event: 'round.finished',
      data: { round: roundNumber },
      broadcast,
    });

    if (roundHadFailureOrBlock) {
      break;
    }
  }

  // Optional Learner phase on the Run Log before run.finished
  const runLogPath = path.join(stateRoot, project.unitId, 'runs', `${runId}.jsonl`);
  const learnerRes = await runGantryScript('learner.py', [runLogPath, '--json'], {
    repoRoot,
    skillDir,
  });
  const learnerData =
    learnerRes.exitCode === 0 ? JSON.parse(learnerRes.stdout) : { candidates: [] };
  const rawCandidates = (learnerData.candidates ?? []) as Array<{
    lesson: string;
    evidence: string[];
    target: string;
  }>;

  if (rawCandidates.length > 0 && completedIssues.length > 0) {
    const lastIssue = completedIssues[completedIssues.length - 1];
    await appendRunEvent({
      repoRoot,
      skillDir,
      stateRoot,
      unitId: project.unitId,
      runId,
      event: 'phase.started',
      issue: lastIssue,
      phase: 'Learner',
      broadcast,
    });
    await appendRunEvent({
      repoRoot,
      skillDir,
      stateRoot,
      unitId: project.unitId,
      runId,
      event: 'subagent.started',
      issue: lastIssue,
      phase: 'Learner',
      data: { role: 'learner' },
      broadcast,
    });
    await appendRunEvent({
      repoRoot,
      skillDir,
      stateRoot,
      unitId: project.unitId,
      runId,
      event: 'subagent.stopped',
      issue: lastIssue,
      phase: 'Learner',
      data: { role: 'learner', result: { candidates: rawCandidates } },
      broadcast,
    });
    await appendRunEvent({
      repoRoot,
      skillDir,
      stateRoot,
      unitId: project.unitId,
      runId,
      event: 'phase.finished',
      issue: lastIssue,
      phase: 'Learner',
      broadcast,
    });
  }

  const lessonCandidates = rawCandidates.map((c, idx) => ({
    id: `lesson-${idx + 1}`,
    evidence: (c.evidence ?? []).join('; '),
    target: c.target ?? 'AGENTS.md',
    draftRule: c.lesson,
  }));

  for (const wt of Object.values(runCtx.worktreesByIssue)) {
    if (fs.existsSync(wt.worktreePath)) {
      await runGantryScript('runlog.py', ['unmark', '--cwd', wt.worktreePath], {
        repoRoot: wt.worktreePath,
        skillDir,
      });
    }
  }

  await appendRunEvent({
    repoRoot,
    skillDir,
    stateRoot,
    unitId: project.unitId,
    runId,
    event: 'run.finished',
    broadcast,
  });

  const cleanupPlanRes = await runGantryScript(
    'cleanup.py',
    ['--plan', '--run-branch', runBranch, '--cwd', repoRoot, '--json'],
    { repoRoot, skillDir },
  );
  const rawPlanJson =
    cleanupPlanRes.exitCode === 0
      ? (JSON.parse(cleanupPlanRes.stdout) as Record<string, unknown>)
      : { run_branch: runBranch, worktrees: [], branches: [] };

  runCtx.cleanupPlanJson = rawPlanJson;

  const worktreesToRemove = ((rawPlanJson.worktrees ?? []) as Array<{ path: string }>).map(
    (w) => w.path,
  );
  const branchesToRemove = ((rawPlanJson.branches ?? []) as Array<{ name: string }>).map(
    (b) => b.name,
  );

  // Build authoritative criteria and Critic evidence per completed Issue for the English PR body
  const issueEvidenceLines: string[] = [];
  for (const ref of completedIssues) {
    const accRes = await runGantryScript('acceptance.py', [ref, '--json'], {
      repoRoot,
      skillDir,
    });
    const accData = accRes.exitCode === 0 ? JSON.parse(accRes.stdout) : { criteria: [] };
    const criteriaList = ((accData.criteria ?? []) as Array<{ text: string }>).map((c) => c.text);
    const criticEv = runCtx.criticEvidenceByIssue[ref] ?? ['Verified by Critic'];
    issueEvidenceLines.push(
      `### ${ref}\n- **Criteria**: ${criteriaList.join('; ') || 'All criteria met'}\n- **Critic Evidence**: ${criticEv.join('; ')}`,
    );
  }

  const handoffCard: DecisionCardPayload = {
    kind: 'run_handoff',
    runId,
    tier: 'supported',
    runBranch,
    targetBranch,
    lessonCandidates,
    prDraft: {
      title: `feat(${scope}): complete Gantry Run ${runId}`,
      body: [
        `## Summary`,
        `Completed Issues: ${completedIssues.join(', ')}`,
        `Run Branch: \`${runBranch}\` -> Target Branch: \`${targetBranch}\``,
        `Support Tier: supported`,
        ``,
        `## Completed Issues & Critic Evidence`,
        ...issueEvidenceLines,
      ].join('\n'),
    },
    cleanupPlan: {
      worktreesToRemove,
      branchesToRemove,
      rawPlanJson,
    },
  };

  store.updateProjectState(project.id, {
    lifecycleState: 'awaiting_handoff_decisions',
    badgeState: 'done',
  });

  const msg = store.appendMessage({
    projectId: project.id,
    sessionId,
    role: 'assistant',
    content: `Run **${runId}** completed on branch \`${runBranch}\` (${completedIssues.join(', ')}). Review Lesson Candidates, Draft PR handoff, and Cleanup Authorization below:`,
    decisionCard: handoffCard,
  });

  broadcast({
    type: 'run.completed',
    projectId: project.id,
    runId,
    runBranch,
    targetBranch,
    completedIssues,
    message: msg,
  });

  return {
    status: 'completed',
    runId,
    runBranch,
    targetBranch,
    completedIssues,
    decisionCard: handoffCard,
    messageId: msg.id,
  };
}

export async function steerSubagent(params: {
  project: RegisteredProject;
  ptySupervisor: PtySupervisor;
  stateRoot: string;
  runId: string;
  issueRef: string;
  mode: 'queue' | 'send_now';
  instruction: string;
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<{ queued: boolean; interrupted: boolean; mode: string; issueRef: string }> {
  const ctx = activeRunContexts.get(params.runId);
  let interrupted = false;

  if (params.mode === 'send_now') {
    if (ctx) {
      ctx.immediateSteeringByIssue[params.issueRef] = [
        ...(ctx.immediateSteeringByIssue[params.issueRef] ?? []),
        params.instruction,
      ];
    }
    // If a takeover/subagent pane is active for this issue, write directly to its PTY!
    const paneId = `takeover-${params.issueRef.replace('#', '-')}`;
    const existingPane = params.ptySupervisor.getPane(params.project.id, paneId);
    if (existingPane) {
      await params.ptySupervisor.writeInput(
        params.project.id,
        paneId,
        `${params.instruction}\n`,
        params.broadcast,
      );
    }
    interrupted = true;
  } else if (ctx) {
    ctx.queuedSteeringByIssue[params.issueRef] = [
      ...(ctx.queuedSteeringByIssue[params.issueRef] ?? []),
      params.instruction,
    ];
  }

  params.broadcast({
    type: 'run.steered',
    runId: params.runId,
    issueRef: params.issueRef,
    mode: params.mode,
    interrupted,
    instruction: params.instruction,
  });

  return {
    queued: true,
    interrupted,
    mode: params.mode,
    issueRef: params.issueRef,
  };
}

export async function takeoverWorktreeInTerminal(params: {
  project: RegisteredProject;
  ptySupervisor: PtySupervisor;
  runId: string;
  issueRef: string;
  worktreePath: string;
  launcher: 'claude' | 'codex' | 'opencode' | 'agy' | 'shell';
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<{
  status: string;
  pausedPhase: string;
  pane: Awaited<ReturnType<PtySupervisor['spawnPane']>>;
}> {
  const ctx = activeRunContexts.get(params.runId);
  const pausedPhase = ctx?.pausedPhaseByIssue[params.issueRef] ?? 'Implement';
  if (ctx) {
    ctx.operatorTakeoverByIssue[params.issueRef] = true;
    ctx.pausedPhaseByIssue[params.issueRef] = pausedPhase;
  }
  const pane = await params.ptySupervisor.spawnPane({
    projectId: params.project.id,
    paneId: `takeover-${params.issueRef.replace('#', '-')}`,
    worktreePath: params.worktreePath,
    launcher: params.launcher,
    mode: 'terminal',
    broadcast: params.broadcast,
  });
  params.broadcast({
    type: 'run.takeover.started',
    projectId: params.project.id,
    runId: params.runId,
    issueRef: params.issueRef,
    pausedPhase,
    pane,
  });
  return {
    status: 'operator_takeover',
    pausedPhase,
    pane,
  };
}

export async function resumeFromTakeover(params: {
  project: RegisteredProject;
  store: HarnessStateStore;
  stateRoot: string;
  profileRoot: string;
  runId: string;
  issueRef: string;
  sessionId: string;
  roleDispatcher?: RoleDispatcher;
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<Record<string, unknown>> {
  const ctx = activeRunContexts.get(params.runId);
  const wtEntry = ctx?.worktreesByIssue[params.issueRef];
  if (wtEntry && fs.existsSync(wtEntry.worktreePath)) {
    const branchRes = await runCommand(['git', 'branch', '--show-current'], {
      cwd: wtEntry.worktreePath,
    });
    if (branchRes.stdout.trim() && branchRes.stdout.trim() !== wtEntry.branch) {
      throw new Error(
        `Worktree branch mismatch during takeover resume: expected ${wtEntry.branch}, found ${branchRes.stdout.trim()}`,
      );
    }
  }
  if (ctx) {
    ctx.operatorTakeoverByIssue[params.issueRef] = false;
  }
  const slug = params.issueRef.split('#')[0];
  return executeRunWorkflow({
    project: params.project,
    store: params.store,
    stateRoot: params.stateRoot,
    profileRoot: params.profileRoot,
    scope: slug,
    sessionId: params.sessionId,
    priorRunId: params.runId,
    resumeIssueRef: params.issueRef,
    resumePhase: ctx?.pausedPhaseByIssue[params.issueRef] ?? 'Implement',
    roleDispatcher: params.roleDispatcher,
    broadcast: params.broadcast,
  });
}

export async function recoverPausedIssue(params: {
  project: RegisteredProject;
  store: HarnessStateStore;
  stateRoot: string;
  profileRoot: string;
  runId: string;
  issueRef: string;
  role: string;
  replacement: { harness: string; model: string; effort?: string };
  sessionId: string;
  roleDispatcher?: RoleDispatcher;
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<Record<string, unknown>> {
  const { project, store, stateRoot, profileRoot, runId, issueRef, role, replacement, sessionId } =
    params;
  const repoRoot = path.resolve(project.path);
  const skillDir = resolveSkillDir(repoRoot).skillDir!;

  const valRes = await runGantryScript(
    'execution.py',
    [
      'validate-replacement',
      '--issue',
      issueRef,
      '--role',
      role,
      '--selection',
      JSON.stringify(replacement),
      '--cwd',
      repoRoot,
      '--json',
    ],
    { repoRoot, skillDir },
  );
  if (valRes.exitCode !== 0) {
    throw new Error(`Invalid role replacement: ${valRes.stderr || valRes.stdout}`);
  }

  let runCtx = activeRunContexts.get(runId);
  if (!runCtx) {
    runCtx = {
      runId,
      projectId: project.id,
      scope: issueRef.split('#')[0],
      sessionId,
      runBranch: `gantry/run-${issueRef.split('#')[0]}`,
      targetBranch: 'main',
      worktreesByIssue: {},
      queuedSteeringByIssue: {},
      immediateSteeringByIssue: {},
      issueRoleOverrides: {},
      pausedPhaseByIssue: {},
      operatorTakeoverByIssue: {},
      criticEvidenceByIssue: {},
    };
    activeRunContexts.set(runId, runCtx);
  }

  const normalizedRole =
    role === 'implementer' ? 'implement' : role === 'reviewer' ? 'review' : role;
  const previousSelection = runCtx.issueRoleOverrides[issueRef]?.[normalizedRole] ?? {
    harness: 'opencode',
    model: 'anthropic/claude-opus-4-5',
  };
  runCtx.issueRoleOverrides[issueRef] = {
    ...(runCtx.issueRoleOverrides[issueRef] ?? {}),
    [normalizedRole]: replacement,
  };

  await appendRunEvent({
    repoRoot,
    skillDir,
    stateRoot,
    unitId: project.unitId,
    runId,
    event: 'role.changed',
    issue: issueRef,
    data: {
      role: normalizedRole,
      requested: previousSelection,
      effective: replacement,
    },
    broadcast: params.broadcast,
  });

  for (const m of store.listMessages(project.id, sessionId)) {
    if (m.decisionCard?.kind === 'issue_recovery' && !m.decisionCard.resolved) {
      const resolved = store.resolveDecisionCard(m.id, { replacement });
      if (resolved) {
        params.broadcast({ type: 'decision_card.resolved', message: resolved });
      }
    }
  }

  const slug = issueRef.split('#')[0];
  const resumePhase = runCtx.pausedPhaseByIssue[issueRef] ?? 'Implement';

  return executeRunWorkflow({
    project,
    store,
    stateRoot,
    profileRoot,
    scope: slug,
    sessionId,
    priorRunId: runId,
    resumeIssueRef: issueRef,
    resumePhase,
    roleDispatcher: params.roleDispatcher,
    broadcast: params.broadcast,
  });
}

export async function decideLessonCandidate(params: {
  project: RegisteredProject;
  runId: string;
  lessonId: string;
  decision: 'accept' | 'dismiss';
  targetFile?: string;
  draftRule?: string;
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<{ applied: boolean; decision: string; targetFile?: string }> {
  const repoRoot = path.resolve(params.project.path);
  if (params.decision === 'accept' && params.draftRule) {
    const cleanTarget = (params.targetFile ?? 'AGENTS.md').split(' ')[0];
    const resolvedTarget = path.resolve(repoRoot, cleanTarget);
    if (!resolvedTarget.startsWith(repoRoot + path.sep)) {
      throw new Error('Lesson target path escapes repository root');
    }
    const existing = fs.existsSync(resolvedTarget)
      ? fs.readFileSync(resolvedTarget, 'utf-8')
      : `# ${cleanTarget}\n`;
    const updated = `${existing.trimEnd()}\n\n- **Lesson (${params.runId})**: ${params.draftRule}\n`;
    fs.writeFileSync(resolvedTarget, updated, 'utf-8');
    params.broadcast({
      type: 'run.lesson.accepted',
      projectId: params.project.id,
      runId: params.runId,
      lessonId: params.lessonId,
      targetFile: cleanTarget,
    });
    return { applied: true, decision: 'accept', targetFile: cleanTarget };
  }

  params.broadcast({
    type: 'run.lesson.dismissed',
    projectId: params.project.id,
    runId: params.runId,
    lessonId: params.lessonId,
  });
  return { applied: false, decision: 'dismiss' };
}

export async function createRunDraftPullRequest(params: {
  project: RegisteredProject;
  runId: string;
  title: string;
  body: string;
  runBranch: string;
  targetBranch: string;
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<{ created: boolean; url?: string; handoff: string }> {
  const repoRoot = path.resolve(params.project.path);
  const ghCheck = await runCommand(['gh', '--version'], { cwd: repoRoot });
  if (ghCheck.exitCode === 0) {
    const prRes = await runCommand(
      [
        'gh',
        'pr',
        'create',
        '--draft',
        '--base',
        params.targetBranch,
        '--head',
        params.runBranch,
        '--title',
        params.title,
        '--body',
        params.body,
      ],
      { cwd: repoRoot },
    );
    if (prRes.exitCode === 0) {
      const url = prRes.stdout.trim();
      params.broadcast({
        type: 'run.pr.created',
        projectId: params.project.id,
        runId: params.runId,
        url,
      });
      return { created: true, url, handoff: `${params.runBranch} -> ${params.targetBranch}` };
    }
  }
  return {
    created: false,
    handoff: `Draft PR ready for ${params.runBranch} -> ${params.targetBranch}`,
  };
}

export async function authorizeRunCleanup(params: {
  project: RegisteredProject;
  runId: string;
  rawPlanJson: Record<string, unknown>;
  broadcast: (evt: Record<string, unknown>) => void;
}): Promise<{ authorized: boolean; result: Record<string, unknown> }> {
  const repoRoot = path.resolve(params.project.path);
  const skillDir = resolveSkillDir(repoRoot).skillDir!;

  // Verify the submitted plan matches the Run's generated cleanup plan when recorded
  const runCtx = activeRunContexts.get(params.runId);
  if (
    runCtx?.cleanupPlanJson &&
    JSON.stringify(runCtx.cleanupPlanJson) !== JSON.stringify(params.rawPlanJson)
  ) {
    throw new Error('Cleanup plan divergence: submitted plan does not match the Run cleanup plan');
  }

  const tmpPlanFile = path.join(repoRoot, `.gantry-cleanup-plan-${Date.now()}.json`);
  fs.writeFileSync(tmpPlanFile, JSON.stringify(params.rawPlanJson, null, 2), 'utf-8');

  try {
    const res = await runGantryScript(
      'cleanup.py',
      ['--yes', '--plan-file', tmpPlanFile, '--cwd', repoRoot, '--json'],
      { repoRoot, skillDir },
    );
    const parsed = res.stdout.trim() ? JSON.parse(res.stdout) : {};
    params.broadcast({
      type: 'run.cleanup.completed',
      projectId: params.project.id,
      runId: params.runId,
      result: parsed,
    });
    return {
      authorized: res.exitCode === 0,
      result: parsed,
    };
  } finally {
    if (fs.existsSync(tmpPlanFile)) {
      fs.unlinkSync(tmpPlanFile);
    }
  }
}

export function buildProjectKanban(
  project: RegisteredProject,
  stateRoot: string,
): {
  projectId: string;
  unitId: string;
  runs: Array<{
    runId: string;
    finished: boolean;
    columns: Record<
      'Ready' | 'Plan' | 'Implement' | 'Review' | 'Critic' | 'Integrate' | 'Done' | 'Blocked',
      Array<{ ref: string; phase: string; operatorWaiting: boolean }>
    >;
  }>;
} {
  const runsDir = path.join(stateRoot, project.unitId, 'runs');
  const runs: Array<{
    runId: string;
    finished: boolean;
    columns: Record<
      'Ready' | 'Plan' | 'Implement' | 'Review' | 'Critic' | 'Integrate' | 'Done' | 'Blocked',
      Array<{ ref: string; phase: string; operatorWaiting: boolean }>
    >;
  }> = [];

  if (!fs.existsSync(runsDir)) {
    return { projectId: project.id, unitId: project.unitId, runs };
  }

  const files = fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl')).sort();
  for (const file of files) {
    const runId = file.replace(/\.jsonl$/, '');
    const issueMap = new Map<
      string,
      {
        ref: string;
        column:
          | 'Ready'
          | 'Plan'
          | 'Implement'
          | 'Review'
          | 'Critic'
          | 'Integrate'
          | 'Done'
          | 'Blocked';
        phase: string;
        operatorWaiting: boolean;
      }
    >();
    let finished = false;

    const lines = fs.readFileSync(path.join(runsDir, file), 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as {
          event: string;
          issue?: string;
          phase?: string;
          data?: Record<string, unknown>;
        };
        if (evt.event === 'run.finished' || evt.event === 'run.cancelled') {
          finished = true;
        }
        if (!evt.issue) continue;
        const entry = issueMap.get(evt.issue) ?? {
          ref: evt.issue,
          column: 'Ready',
          phase: 'Ready',
          operatorWaiting: false,
        };

        if (evt.event === 'phase.started' && evt.phase) {
          const validCols = ['Plan', 'Implement', 'Review', 'Critic', 'Integrate'] as const;
          if ((validCols as readonly string[]).includes(evt.phase)) {
            entry.column = evt.phase as typeof entry.column;
            entry.phase = evt.phase;
          }
          entry.operatorWaiting = Boolean(evt.data?.operatorWaiting);
        } else if (evt.event === 'operator.waiting') {
          entry.operatorWaiting = true;
        } else if (evt.event === 'operator.approved') {
          entry.operatorWaiting = false;
        } else if (evt.event === 'issue.done') {
          entry.column = 'Done';
          entry.operatorWaiting = false;
        } else if (evt.event === 'issue.blocked' || evt.event === 'issue.paused') {
          entry.column = 'Blocked';
          entry.operatorWaiting = false;
        }
        issueMap.set(evt.issue, entry);
      } catch {
        // ignore
      }
    }

    const columns: Record<
      'Ready' | 'Plan' | 'Implement' | 'Review' | 'Critic' | 'Integrate' | 'Done' | 'Blocked',
      Array<{ ref: string; phase: string; operatorWaiting: boolean }>
    > = {
      Ready: [],
      Plan: [],
      Implement: [],
      Review: [],
      Critic: [],
      Integrate: [],
      Done: [],
      Blocked: [],
    };

    for (const item of issueMap.values()) {
      columns[item.column].push({
        ref: item.ref,
        phase: item.phase,
        operatorWaiting: item.operatorWaiting,
      });
    }

    runs.push({ runId, finished, columns });
  }

  return { projectId: project.id, unitId: project.unitId, runs };
}
