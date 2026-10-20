import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_TERMINAL_SETTINGS, shellDefinitions, validateTerminalSettings } from './terminalSettings.js';
import type { TerminalSettings } from '../types.js';
import type { HarnessRunRecord } from '../boardModel.js';
import { createRequire } from 'node:module';
import type { SQLInputValue } from 'node:sqlite';
import type {
  ChatMessageRecord,
  DecisionCardPayload,
  LiveBadgeState,
  ExecutionSettings,
  RegisteredProject,
  RunLifecycleState,
  WorkspaceLayoutState,
} from '../types.js';

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: SQLInputValue[]): { changes: number | bigint };
    get(...params: SQLInputValue[]): unknown;
    all(...params: SQLInputValue[]): unknown[];
  };
  close(): void;
}

const requireRuntime = createRequire(import.meta.url);
const Database: new (filename: string) => SqliteDatabase = process.versions.bun
  ? requireRuntime('bun:sqlite').Database
  : requireRuntime('node:sqlite').DatabaseSync;

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
  private db: SqliteDatabase;

  constructor(gantryHome: string) {
    this.harnessDir = path.join(path.resolve(gantryHome), 'harness');
    fs.mkdirSync(this.harnessDir, { recursive: true });
    this.dbPath = path.join(this.harnessDir, 'harness.db');
    this.settingsPath = path.join(this.harnessDir, 'settings.json');
    this.db = new Database(this.dbPath);
    this.initSchema();
  }

  private ensureColumn(table: 'projects' | 'sessions' | 'messages', column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((info) => info.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private migrateLegacySchema(): void {
    // Databases created before these columns existed stay readable. CREATE TABLE
    // IF NOT EXISTS does not add columns to a table that is already there.
    this.ensureColumn('projects', 'unit_id', `TEXT NOT NULL DEFAULT ''`);
    this.ensureColumn('projects', 'badge_state', `TEXT NOT NULL DEFAULT 'idle'`);
    this.ensureColumn('projects', 'lifecycle_state', `TEXT NOT NULL DEFAULT 'idle'`);
    this.ensureColumn('sessions', 'slug', 'TEXT');
    this.ensureColumn('messages', 'turn_blocks_json', 'TEXT');
    this.ensureColumn('messages', 'decision_card_json', 'TEXT');
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

      CREATE TABLE IF NOT EXISTS runs (
        project_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        run_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        child_pid INTEGER,
        lane TEXT,
        pack_phase TEXT,
        branch TEXT,
        worktree TEXT,
        pushed INTEGER NOT NULL DEFAULT 0,
        pause_json TEXT,
        terminal_event TEXT,
        error_json TEXT,
        pr_url TEXT,
        derived_phase TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, ref)
      );
    `);
    this.migrateLegacySchema();

    if (!fs.existsSync(this.settingsPath)) {
      this.writeRawSettings({});
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
    this.db.prepare(`DELETE FROM runs WHERE project_id = ?`).run(projectId);
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

  public getTerminalSettings(): TerminalSettings {
    const row = this.db.prepare('SELECT value_json FROM workspace_kv WHERE key = ?').get('terminal_settings') as { value_json: string } | undefined;
    const saved = row ? JSON.parse(row.value_json) as TerminalSettings : DEFAULT_TERMINAL_SETTINGS;
    const shell = saved.shell === 'system' || shellDefinitions(process.platform).some((option) => option.id === saved.shell) ? saved.shell : 'system';
    return { ...saved, shell };
  }

  public updateTerminalSettings(input: unknown): TerminalSettings {
    const settings = validateTerminalSettings(input);
    this.db.prepare('INSERT INTO workspace_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run('terminal_settings', JSON.stringify(settings));
    return settings;
  }

  private readSettingsFile(): { execution?: ExecutionSettings } {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.settingsPath, 'utf-8')) as { execution?: ExecutionSettings };
      return parsed.execution && typeof parsed.execution === 'object' ? { execution: parsed.execution } : {};
    } catch {
      return {};
    }
  }

  private writeRawSettings(settings: { execution?: ExecutionSettings }): void {
    fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  public getGlobalExecution(): ExecutionSettings {
    const execution = this.readSettingsFile().execution;
    if (!execution || typeof execution !== 'object') return {};
    return execution;
  }

  public updateGlobalExecution(input: ExecutionSettings): ExecutionSettings {
    const current = this.readSettingsFile();
    const roles = input.roles && typeof input.roles === 'object' ? input.roles : {};
    const execution: ExecutionSettings = {
      ...(typeof input.hostHarness === 'string' && input.hostHarness ? { hostHarness: input.hostHarness } : {}),
      ...(Object.keys(roles).length ? { roles } : {}),
    };
    this.writeRawSettings({ execution });
    return execution;
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

  public saveRun(record: HarnessRunRecord): HarnessRunRecord {
    const updatedAt = new Date().toISOString();
    const persisted: HarnessRunRecord = {
      ...record,
      updatedAt,
    };
    this.db
      .prepare(
        `INSERT INTO runs (
           project_id, ref, run_id, slug, kind, status, child_pid, lane, pack_phase,
           branch, worktree, pushed, pause_json, terminal_event, error_json, pr_url,
           derived_phase, record_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, ref) DO UPDATE SET
           run_id = excluded.run_id,
           slug = excluded.slug,
           kind = excluded.kind,
           status = excluded.status,
           child_pid = excluded.child_pid,
           lane = excluded.lane,
           pack_phase = excluded.pack_phase,
           branch = excluded.branch,
           worktree = excluded.worktree,
           pushed = excluded.pushed,
           pause_json = excluded.pause_json,
           terminal_event = excluded.terminal_event,
           error_json = excluded.error_json,
           pr_url = excluded.pr_url,
           derived_phase = excluded.derived_phase,
           record_json = excluded.record_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        persisted.projectId,
        persisted.ref,
        persisted.runId,
        persisted.slug,
        persisted.kind,
        persisted.status,
        persisted.childPid,
        persisted.lane,
        persisted.packPhase,
        persisted.branch,
        persisted.worktree,
        persisted.pushed ? 1 : 0,
        persisted.pause ? JSON.stringify(persisted.pause) : null,
        persisted.terminalEvent,
        persisted.error ? JSON.stringify(persisted.error) : null,
        persisted.prUrl,
        persisted.derivedPhase,
        JSON.stringify(persisted),
        persisted.createdAt,
        persisted.updatedAt,
      );
    return persisted;
  }

  public getRun(projectId: string, ref: string): HarnessRunRecord | null {
    const row = this.db
      .prepare(`SELECT record_json FROM runs WHERE project_id = ? AND ref = ?`)
      .get(projectId, ref) as { record_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.record_json) as HarnessRunRecord;
    } catch {
      return null;
    }
  }

  public listRuns(projectId: string): HarnessRunRecord[] {
    const rows = this.db
      .prepare(`SELECT record_json FROM runs WHERE project_id = ? ORDER BY created_at ASC`)
      .all(projectId) as Array<{ record_json: string }>;
    const out: HarnessRunRecord[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.record_json) as HarnessRunRecord);
      } catch {
        // ignore corrupted row
      }
    }
    return out;
  }

  public deleteRun(projectId: string, ref: string): boolean {
    const res = this.db
      .prepare(`DELETE FROM runs WHERE project_id = ? AND ref = ?`)
      .run(projectId, ref);
    return Number(res.changes) > 0;
  }

  public close(): void {
    this.db.close();
  }
}
