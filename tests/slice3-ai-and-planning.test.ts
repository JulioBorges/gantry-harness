import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHarnessServer } from '../src/server/app.js';

function initTempGitRepo(baseDir: string, name: string): string {
  const repoDir = path.join(baseDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), `# ${name}\n`, 'utf-8');
  fs.writeFileSync(
    path.join(repoDir, 'AGENTS.md'),
    `# Agents\n\nConverse with the operator in Portuguese (pt-BR).\n`,
    'utf-8',
  );
  fs.writeFileSync(
    path.join(repoDir, 'GLOSSARY.md'),
    `# Glossary\n\n- **Order**: Customer purchase request.\n`,
    'utf-8',
  );
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), `export const version = '1.0.0';\n`, 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });
  return repoDir;
}

describe('Slice 3: Primary AI Service, Language Governance, Socratic Gate (/plan) & Planning Approval', () => {
  let tmpRoot: string;
  let gantryHome: string;
  let stateRoot: string;
  let profileRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-harness-s3-'));
    gantryHome = path.join(tmpRoot, '.gantry');
    stateRoot = path.join(gantryHome, 'state');
    profileRoot = path.join(gantryHome, 'profiles');
    fs.mkdirSync(gantryHome, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('resolves language policy from AGENTS.md and GLOSSARY.md while keeping Gantry artifacts in English', async () => {
    const repoDir = initTempGitRepo(tmpRoot, 'repo-lang');
    const server = await createHarnessServer({
      gantryHome,
      stateRoot,
      profileRoot,
      port: 0,
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const reg = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repoDir }),
      }).then((r) => r.json());

      const langPolicy = await fetch(`${baseUrl}/api/projects/${reg.project.id}/language-policy`).then(
        (r) => r.json(),
      );
      expect(langPolicy.conversationLanguage).toBe('pt-BR');
      expect(langPolicy.artifactLanguage).toBe('en');
      expect(langPolicy.source).toBe('AGENTS.md');
      expect(langPolicy.glossaryTerms).toContain('Order');
    } finally {
      await server.close();
    }
  });

  it('runs multi-round Grilling localized in pt-BR, records operatorWaiting/approved in runlog.py, handles spec_blocked refinement, auto-revises on Plan Critic refutation, and transitions via roadmap.py on approval', async () => {
    const repoDir = initTempGitRepo(tmpRoot, 'repo-plan');
    fs.writeFileSync(path.join(repoDir, 'ROADMAP.md'), '# Project Roadmap Header\n\nCustom intro paragraph.\n', 'utf-8');
    execFileSync('git', ['add', 'ROADMAP.md'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'Add custom roadmap header'], { cwd: repoDir });

    let reqCriticCalls = 0;
    let planCriticCalls = 0;

    const server = await createHarnessServer({
      gantryHome,
      stateRoot,
      profileRoot,
      port: 0,
      roleDispatcher: async (req) => {
        if (req.role === 'requirement-critic') {
          reqCriticCalls += 1;
          if (reqCriticCalls === 1) {
            return {
              blocking: [
                {
                  quote: 'Retry policy is unspecified',
                  reason: 'Webhook delivery must specify maximum retry count and backoff.',
                },
              ],
              findings: [
                {
                  quote: 'Retry policy is unspecified',
                  reason: 'Webhook delivery must specify maximum retry count and backoff.',
                },
              ],
            };
          }
          return { blocking: [], findings: [] };
        }
        if (req.role === 'plan-critic') {
          planCriticCalls += 1;
          if (planCriticCalls === 1) {
            return {
              acceptable: false,
              problems: [
                {
                  problem: 'Slice #01 needs explicit idempotency boundary note',
                  fix: 'Document idempotency key handling in Slice #01',
                },
              ],
              frontierErrors: [],
            };
          }
          return {
            acceptable: true,
            problems: [],
            frontierErrors: [],
          };
        }
        return {};
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const reg = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repoDir }),
      }).then((r) => r.json());

      // Start /plan workflow
      const startRes = await fetch(`${baseUrl}/api/projects/${reg.project.id}/plan/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: 'Add Order checkout webhook',
          slug: 'order-webhook',
          sessionId: reg.defaultSessionId,
        }),
      }).then((r) => r.json());

      expect(startRes.slug).toBe('order-webhook');
      expect(startRes.runId).toMatch(/^run-/);
      expect(startRes.decisionCard.kind).toBe('grilling_round');
      expect(startRes.decisionCard.roundNumber).toBe(1);
      expect(startRes.decisionCard.questions.length).toBeGreaterThan(0);
      expect(startRes.decisionCard.questions[0].title).toContain('Order');
      expect(startRes.contextExplored.glossaryFound).toBe(true);
      expect(startRes.contextExplored.excerpts['GLOSSARY.md']).toContain('Customer purchase request');

      // Round 1 answer with finishGrilling: false -> produces Round 2 grilling_round card
      const round2Res = await fetch(`${baseUrl}/api/projects/${reg.project.id}/plan/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'order-webhook',
          runId: startRes.runId,
          sessionId: reg.defaultSessionId,
          roundNumber: 1,
          finishGrilling: false,
          answers: {
            q1: 'Entregar payload JSON assinado over HTTPS',
          },
        }),
      }).then((r) => r.json());

      expect(round2Res.decisionCard.kind).toBe('grilling_round');
      expect(round2Res.decisionCard.roundNumber).toBe(2);

      // Verify runlog.py recorded run.started, phase.started (operatorWaiting: true), and operator.approved
      const logFile = path.join(stateRoot, reg.project.unitId, 'runs', `${startRes.runId}.jsonl`);
      expect(fs.existsSync(logFile)).toBe(true);
      const eventsAfterR1 = fs
        .readFileSync(logFile, 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(eventsAfterR1.some((e) => e.event === 'run.started')).toBe(true);
      expect(
        eventsAfterR1.some(
          (e) => e.event === 'phase.started' && e.phase === 'Plan' && e.data?.operatorWaiting === true,
        ),
      ).toBe(true);
      expect(eventsAfterR1.some((e) => e.event === 'operator.approved')).toBe(true);

      // Submit Round 2 answer with finishGrilling: true -> triggers Requirement Critic 1st call (blocking finding -> spec_blocked card)
      const blockedAnswerRes = await fetch(`${baseUrl}/api/projects/${reg.project.id}/plan/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'order-webhook',
          runId: startRes.runId,
          sessionId: reg.defaultSessionId,
          roundNumber: 2,
          finishGrilling: true,
          answers: {
            q2: 'Idempotency key header per Order event',
          },
        }),
      }).then((r) => r.json());

      expect(blockedAnswerRes.decisionCard.kind).toBe('spec_blocked');
      expect(blockedAnswerRes.decisionCard.source).toBe('requirement_critic');
      expect(blockedAnswerRes.decisionCard.findings[0].quote).toContain('Retry policy');

      // Refine Spec to resolve the blocking finding -> Requirement Critic 2nd call passes -> Plan Critic 1st call refutes -> automatic revision on disk -> Plan Critic 2nd call accepts -> emits plan_approval card
      const refineRes = await fetch(`${baseUrl}/api/projects/${reg.project.id}/plan/refine-spec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'order-webhook',
          runId: startRes.runId,
          sessionId: reg.defaultSessionId,
          amendment: 'Retry up to 3 times with exponential backoff.',
        }),
      }).then((r) => r.json());

      expect(refineRes.specValidation.valid).toBe(true);
      expect(refineRes.planCriticAutoRevised).toBe(true);
      expect(planCriticCalls).toBe(2);
      expect(refineRes.decisionCard.kind).toBe('plan_approval');
      expect(refineRes.decisionCard.issues.length).toBeGreaterThanOrEqual(2);
      expect(refineRes.decisionCard.issues[0].ref).toBe('order-webhook#01');
      expect(refineRes.decisionCard.issues[0].estimatedTokens).toBeGreaterThan(0);
      expect(refineRes.decisionCard.issues[0].budgetTokens).toBeGreaterThan(0);
      expect(refineRes.decisionCard.criticVerdict.acceptable).toBe(true);

      // Verify the automatic planner revision actually wrote the fix note to the draft Issue on disk
      const revisedIssue01 = fs.readFileSync(
        path.join(repoDir, refineRes.decisionCard.issues[0].path),
        'utf-8',
      );
      expect(revisedIssue01).toContain('Document idempotency key handling in Slice #01');

      // Verify Spec preserves original goal and translates Portuguese operator input into canonical English
      const specText = fs.readFileSync(
        path.join(repoDir, '.scratch', 'order-webhook', 'spec.md'),
        'utf-8',
      );
      expect(specText).toContain('Add Order checkout webhook');
      expect(specText).toContain('Deliver payload JSON signed over HTTPS');

      // Ask coordinator to split draft issue #02 before approving
      const countBeforeSplit = refineRes.decisionCard.issues.length;
      const editRes = await fetch(`${baseUrl}/api/projects/${reg.project.id}/plan/edit-issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'order-webhook',
          sessionId: reg.defaultSessionId,
          action: 'split',
          targetRef: 'order-webhook#02',
          instruction: 'Split signature verification into dedicated slice',
        }),
      }).then((r) => r.json());

      expect(editRes.decisionCard.kind).toBe('plan_approval');
      expect(editRes.decisionCard.issues.length).toBe(countBeforeSplit + 1);

      // Click Approve Plan -> transitions issues via roadmap.py status <ref> ready-for-agent, waves, check
      const approveRes = await fetch(`${baseUrl}/api/projects/${reg.project.id}/plan/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'order-webhook',
          runId: startRes.runId,
          sessionId: reg.defaultSessionId,
        }),
      }).then((r) => r.json());

      expect(approveRes.approved).toBe(true);
      expect(approveRes.roadmapCheck.drift).toEqual([]);
      expect(fs.existsSync(path.join(repoDir, 'ROADMAP.md'))).toBe(true);
      const roadmapText = fs.readFileSync(path.join(repoDir, 'ROADMAP.md'), 'utf-8');
      expect(roadmapText).toContain('Custom intro paragraph.');
      expect(roadmapText).toContain('order-webhook#01');

      const issue01AfterApprove = fs.readFileSync(
        path.join(repoDir, editRes.decisionCard.issues[0].path),
        'utf-8',
      );
      expect(issue01AfterApprove).toContain('Status: ready-for-agent');
    } finally {
      await server.close();
    }
  });
});
