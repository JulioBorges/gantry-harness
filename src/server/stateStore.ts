import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const requireNode = createRequire(import.meta.url);
const { DatabaseSync } = requireNode('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };
import type {
  ChatMessageRecord,
  DecisionCardPayload,
  LiveBadgeState,
  ProviderSettingsInput,
  RegisteredProject,
  RunLifecycleState,
  SanitizedProviderSettings,
  WorkspaceLayoutState,
} from '../types.js';

export interface SessionRecord {
  id: string;
  projectId: string;
  title: string;
  slug?: string;
  createdAt: string;
  updatedAt: string;
}

export class HarnessStateStore {
  public readonly harnessDir: string;
  public readonly dbPath: string;
  public readonly settingsPath: string;
  private db: DatabaseSyncType;

  constructor(gantryHome: string) {
    this.harnessDir = path.join(path.resolve(gantryHome), 'harness');
    fs.mkdirSync(this.harnessDir, { recursive: true });
    this.dbPath = path.join(this.harnessDir, 'harness.db');
    this.settingsPath = path.join(this.harnessDir, 'settings.json');
    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        unit_id TEXT NOT NULL,
        badge_state TEXT NOT NULL DEFAULT 'idle',
        lifecycle_state TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        slug TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        turn_blocks_json TEXT,
        decision_card_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_kv (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pairing_codes (
        code TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS auth_tokens (
        token TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
    `);

    if (!fs.existsSync(this.settingsPath)) {
      this.writeRawSettings({
        activeProvider: 'cli',
        mode: 'cli',
        cliHarness: 'opencode',
        providers: {},
      });
    }
  }

  public upsertProject(input: {
    path: string;
    name?: string;
    unitId: string;
    badgeState?: LiveBadgeState;
    lifecycleState?: RunLifecycleState;
  }): { project: RegisteredProject; defaultSessionId: string } {
    const resolvedPath = path.resolve(input.path);
    const existing = this.getProjectByPath(resolvedPath);
    const now = new Date().toISOString();

    if (existing) {
      const updatedBadge = input.badgeState ?? existing.badgeState;
      const updatedLifecycle = input.lifecycleState ?? existing.lifecycleState;
      this.db
        .prepare(
          `UPDATE projects SET unit_id = ?, badge_state = ?, lifecycle_state = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.unitId, updatedBadge, updatedLifecycle, now, existing.id);
      const sessions = this.listSessions(existing.id);
      const defaultSessionId =
        sessions[0]?.id ?? this.createSession(existing.id, 'Main Workspace Session').id;
      return {
        project: {
          ...existing,
          unitId: input.unitId,
          badgeState: updatedBadge,
          lifecycleState: updatedLifecycle,
          updatedAt: now,
        },
        defaultSessionId,
      };
    }

    const id = `proj-${crypto.randomUUID().slice(0, 8)}`;
    const name = input.name ?? path.basename(resolvedPath);
    const badgeState = input.badgeState ?? 'idle';
    const lifecycleState = input.lifecycleState ?? 'idle';

    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, unit_id, badge_state, lifecycle_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, resolvedPath, input.unitId, badgeState, lifecycleState, now, now);

    const session = this.createSession(id, 'Main Workspace Session');

    const currentLayout = this.getWorkspaceLayout();
    if (!currentLayout.activeProjectId) {
      this.saveWorkspaceLayout({
        ...currentLayout,
        activeProjectId: id,
        activeSessionId: session.id,
      });
    }

    return {
      project: {
        id,
        name,
        path: resolvedPath,
        unitId: input.unitId,
        badgeState,
        lifecycleState,
        createdAt: now,
        updatedAt: now,
      },
      defaultSessionId: session.id,
    };
  }

  public removeProject(projectId: string): boolean {
    const res = this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
    this.db.prepare(`DELETE FROM sessions WHERE project_id = ?`).run(projectId);
    this.db.prepare(`DELETE FROM messages WHERE project_id = ?`).run(projectId);
    const layout = this.getWorkspaceLayout();
    if (layout.activeProjectId === projectId) {
      const remaining = this.listProjects();
      this.saveWorkspaceLayout({
        ...layout,
        activeProjectId: remaining[0]?.id ?? null,
        activeSessionId: remaining[0] ? (this.listSessions(remaining[0].id)[0]?.id ?? null) : null,
      });
    }
    return Number(res.changes) > 0;
  }

  public updateProjectState(
    projectId: string,
    patch: { badgeState?: LiveBadgeState; lifecycleState?: RunLifecycleState },
  ): RegisteredProject | null {
    const proj = this.getProject(projectId);
    if (!proj) return null;
    const badgeState = patch.badgeState ?? proj.badgeState;
    const lifecycleState = patch.lifecycleState ?? proj.lifecycleState;
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE projects SET badge_state = ?, lifecycle_state = ?, updated_at = ? WHERE id = ?`)
      .run(badgeState, lifecycleState, now, projectId);
    return { ...proj, badgeState, lifecycleState, updatedAt: now };
  }

  public getProject(projectId: string): RegisteredProject | null {
    const row = this.db
      .prepare(`SELECT * FROM projects WHERE id = ?`)
      .get(projectId) as Record<string, string> | undefined;
    return row ? this.mapProjectRow(row) : null;
  }

  public getProjectByPath(projectPath: string): RegisteredProject | null {
    const row = this.db
      .prepare(`SELECT * FROM projects WHERE path = ?`)
      .get(path.resolve(projectPath)) as Record<string, string> | undefined;
    return row ? this.mapProjectRow(row) : null;
  }

  public listProjects(): RegisteredProject[] {
    const rows = this.db
      .prepare(`SELECT * FROM projects ORDER BY created_at ASC`)
      .all() as Array<Record<string, string>>;
    return rows.map((r) => this.mapProjectRow(r));
  }

  private mapProjectRow(row: Record<string, string>): RegisteredProject {
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      unitId: row.unit_id,
      badgeState: row.badge_state as LiveBadgeState,
      lifecycleState: row.lifecycle_state as RunLifecycleState,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  public createSession(projectId: string, title: string, slug?: string): SessionRecord {
    const id = `sess-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, title, slug, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, title, slug ?? null, now, now);
    return { id, projectId, title, slug, createdAt: now, updatedAt: now };
  }

  public listSessions(projectId: string): SessionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at ASC`)
      .all(projectId) as Array<Record<string, string>>;
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      slug: r.slug ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  public appendMessage(input: {
    projectId: string;
    sessionId: string;
    role: 'user' | 'assistant' | 'system' | 'subagent';
    content: string;
    turnBlocks?: ChatMessageRecord['turnBlocks'];
    decisionCard?: DecisionCardPayload & { id?: string; resolved?: boolean; resolution?: unknown };
  }): ChatMessageRecord {
    const id = `msg-${crypto.randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();
    const cardWithId = input.decisionCard
      ? {
          ...input.decisionCard,
          id: input.decisionCard.id ?? `card-${crypto.randomUUID().slice(0, 8)}`,
          resolved: input.decisionCard.resolved ?? false,
        }
      : undefined;

    this.db
      .prepare(
        `INSERT INTO messages (id, project_id, session_id, role, content, turn_blocks_json, decision_card_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.sessionId,
        input.role,
        input.content,
        input.turnBlocks ? JSON.stringify(input.turnBlocks) : null,
        cardWithId ? JSON.stringify(cardWithId) : null,
        createdAt,
      );

    if (cardWithId && !cardWithId.resolved) {
      const targetBadge: LiveBadgeState =
        cardWithId.kind === 'issue_recovery' || cardWithId.kind === 'spec_blocked'
          ? 'blocked'
          : 'needs input';
      this.updateProjectState(input.projectId, { badgeState: targetBadge });
    }

    return {
      id,
      projectId: input.projectId,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      turnBlocks: input.turnBlocks,
      decisionCard: cardWithId,
      createdAt,
    };
  }

  public listPendingAlerts(): Array<{
    id: string;
    projectId: string;
    projectName: string;
    sessionId: string;
    messageId: string;
    badgeState: LiveBadgeState;
    cardKind: string;
    summary: string;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.project_id, m.session_id, m.content, m.decision_card_json, m.created_at, p.name as project_name
         FROM messages m
         JOIN projects p ON p.id = m.project_id
         WHERE m.decision_card_json IS NOT NULL
         ORDER BY m.created_at DESC`,
      )
      .all() as Array<Record<string, string>>;

    const alerts: Array<{
      id: string;
      projectId: string;
      projectName: string;
      sessionId: string;
      messageId: string;
      badgeState: LiveBadgeState;
      cardKind: string;
      summary: string;
      createdAt: string;
    }> = [];

    for (const row of rows) {
      const card = JSON.parse(row.decision_card_json) as DecisionCardPayload & {
        id?: string;
        resolved?: boolean;
      };
      if (card.resolved) continue;
      const badgeState: LiveBadgeState =
        card.kind === 'issue_recovery' || card.kind === 'spec_blocked' ? 'blocked' : 'needs input';
      alerts.push({
        id: card.id ?? row.id,
        projectId: row.project_id,
        projectName: row.project_name,
        sessionId: row.session_id,
        messageId: row.id,
        badgeState,
        cardKind: card.kind,
        summary: row.content,
        createdAt: row.created_at,
      });
    }
    return alerts;
  }

  public listMessages(projectId: string, sessionId?: string): ChatMessageRecord[] {
    const rows = sessionId
      ? (this.db
          .prepare(
            `SELECT * FROM messages WHERE project_id = ? AND session_id = ? ORDER BY created_at ASC`,
          )
          .all(projectId, sessionId) as Array<Record<string, string | null>>)
      : (this.db
          .prepare(`SELECT * FROM messages WHERE project_id = ? ORDER BY created_at ASC`)
          .all(projectId) as Array<Record<string, string | null>>);

    return rows.map((r) => ({
      id: r.id!,
      projectId: r.project_id!,
      sessionId: r.session_id!,
      role: r.role as ChatMessageRecord['role'],
      content: r.content!,
      turnBlocks: r.turn_blocks_json ? JSON.parse(r.turn_blocks_json) : undefined,
      decisionCard: r.decision_card_json ? JSON.parse(r.decision_card_json) : undefined,
      createdAt: r.created_at!,
    }));
  }

  public resolveDecisionCard(messageId: string, resolution: unknown): ChatMessageRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM messages WHERE id = ?`)
      .get(messageId) as Record<string, string | null> | undefined;
    if (!row || !row.decision_card_json) return null;
    const card = JSON.parse(row.decision_card_json);
    card.resolved = true;
    card.resolution = resolution;
    this.db
      .prepare(`UPDATE messages SET decision_card_json = ? WHERE id = ?`)
      .run(JSON.stringify(card), messageId);
    const remainingForProject = this.listPendingAlerts().filter(
      (a) => a.projectId === row.project_id!,
    );
    if (remainingForProject.length === 0) {
      this.updateProjectState(row.project_id!, { badgeState: 'idle' });
    } else {
      const nextBadge: LiveBadgeState = remainingForProject.some((a) => a.badgeState === 'blocked')
        ? 'blocked'
        : 'needs input';
      this.updateProjectState(row.project_id!, { badgeState: nextBadge });
    }
    return {
      id: row.id!,
      projectId: row.project_id!,
      sessionId: row.session_id!,
      role: row.role as ChatMessageRecord['role'],
      content: row.content!,
      turnBlocks: row.turn_blocks_json ? JSON.parse(row.turn_blocks_json) : undefined,
      decisionCard: card,
      createdAt: row.created_at!,
    };
  }

  public getWorkspaceLayout(): WorkspaceLayoutState {
    const row = this.db
      .prepare(`SELECT value_json FROM workspace_kv WHERE key = 'layout'`)
      .get() as { value_json: string } | undefined;
    if (!row) {
      return {
        activeProjectId: null,
        activeSessionId: null,
        openTabs: [{ id: 'tab-factory', title: 'Gantry Factory', kind: 'factory', mode: 'chat' }],
        splitPanes: [],
        scrollPositions: {},
      };
    }
    return JSON.parse(row.value_json) as WorkspaceLayoutState;
  }

  public saveWorkspaceLayout(layout: Partial<WorkspaceLayoutState>): WorkspaceLayoutState {
    const current = this.getWorkspaceLayout();
    const merged: WorkspaceLayoutState = {
      activeProjectId:
        layout.activeProjectId !== undefined ? layout.activeProjectId : current.activeProjectId,
      activeSessionId:
        layout.activeSessionId !== undefined ? layout.activeSessionId : current.activeSessionId,
      openTabs: layout.openTabs ?? current.openTabs,
      splitPanes: layout.splitPanes ?? current.splitPanes,
      scrollPositions: layout.scrollPositions ?? current.scrollPositions,
    };
    this.db
      .prepare(
        `INSERT INTO workspace_kv (key, value_json) VALUES ('layout', ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(JSON.stringify(merged));
    return merged;
  }

  private writeRawSettings(settings: ProviderSettingsInput): void {
    fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  public getRawProviderSettings(): ProviderSettingsInput {
    try {
      return JSON.parse(fs.readFileSync(this.settingsPath, 'utf-8')) as ProviderSettingsInput;
    } catch {
      return {
        activeProvider: 'cli',
        mode: 'cli',
        cliHarness: 'opencode',
        providers: {},
      };
    }
  }

  public updateProviderSettings(input: ProviderSettingsInput): SanitizedProviderSettings {
    const current = this.getRawProviderSettings();
    const nextProviders = { ...(current.providers ?? {}) };
    if (input.providers) {
      for (const [provName, cfg] of Object.entries(input.providers)) {
        nextProviders[provName] = {
          ...(nextProviders[provName] ?? {}),
          ...cfg,
          apiKey: cfg.apiKey !== undefined ? cfg.apiKey : nextProviders[provName]?.apiKey,
        };
      }
    }
    const updated: ProviderSettingsInput = {
      activeProvider: input.activeProvider ?? current.activeProvider,
      mode: input.mode ?? current.mode,
      cliHarness: input.cliHarness ?? current.cliHarness,
      providers: nextProviders,
    };
    this.writeRawSettings(updated);
    return this.getSanitizedProviderSettings();
  }

  public getSanitizedProviderSettings(): SanitizedProviderSettings {
    const raw = this.getRawProviderSettings();
    const sanitizedProviders: SanitizedProviderSettings['providers'] = {};
    for (const [name, cfg] of Object.entries(raw.providers ?? {})) {
      sanitizedProviders[name] = {
        hasApiKey: Boolean(cfg.apiKey && cfg.apiKey.trim().length > 0),
        model: cfg.model,
        baseUrl: cfg.baseUrl,
      };
    }
    return {
      activeProvider: raw.activeProvider,
      mode: raw.mode,
      cliHarness: raw.cliHarness,
      providers: sanitizedProviders,
    };
  }

  public generatePairingCode(): string {
    const code = String(crypto.randomInt(100000, 999999));
    this.db
      .prepare(`INSERT OR REPLACE INTO pairing_codes (code, created_at, used) VALUES (?, ?, 0)`)
      .run(code, Date.now());
    return code;
  }

  public verifyPairingCode(code: string): string | null {
    const row = this.db
      .prepare(`SELECT code, created_at, used FROM pairing_codes WHERE code = ?`)
      .get(code) as { code: string; created_at: number; used: number } | undefined;
    if (!row || row.used !== 0) {
      return null;
    }
    // 10 minute expiry
    if (Date.now() - row.created_at > 10 * 60 * 1000) {
      return null;
    }
    this.db.prepare(`UPDATE pairing_codes SET used = 1 WHERE code = ?`).run(code);
    const token = `gh_tok_${crypto.randomBytes(24).toString('hex')}`;
    this.db
      .prepare(`INSERT INTO auth_tokens (token, created_at) VALUES (?, ?)`)
      .run(token, Date.now());
    return token;
  }

  public isValidAuthToken(token: string): boolean {
    const row = this.db
      .prepare(`SELECT token FROM auth_tokens WHERE token = ?`)
      .get(token) as { token: string } | undefined;
    return Boolean(row);
  }

  public close(): void {
    this.db.close();
  }
}
