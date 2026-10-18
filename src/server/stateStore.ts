import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_TERMINAL_SETTINGS, shellDefinitions, validateTerminalSettings } from './terminalSettings.js';
import type { TerminalSettings } from '../types.js';
import { createRequire } from 'node:module';
import type { SQLInputValue } from 'node:sqlite';
import type {
  ChatMessageRecord,
  LiveBadgeState,
  RegisteredProject,
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

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        unit_id TEXT NOT NULL,
        badge_state TEXT NOT NULL DEFAULT 'idle',
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

    // Migrations: Remove orchestrator columns if they exist
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS projects_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          unit_id TEXT NOT NULL,
          badge_state TEXT NOT NULL DEFAULT 'idle',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO projects_new SELECT id, name, path, unit_id, badge_state, created_at, updated_at FROM projects;
        DROP TABLE projects;
        ALTER TABLE projects_new RENAME TO projects;

        CREATE TABLE IF NOT EXISTS messages_new (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          turn_blocks_json TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO messages_new SELECT id, project_id, session_id, role, content, turn_blocks_json, created_at FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_new RENAME TO messages;
      `);
    } catch (err) {
      // Migrations already applied or tables don't exist yet
    }

    // Removed: settings file initialization (orchestrator provider settings no longer needed)
  }

  public upsertProject(input: {
    path: string;
    name?: string;
    unitId: string;
    badgeState?: LiveBadgeState;
  }): { project: RegisteredProject; defaultSessionId: string } {
    const resolvedPath = path.resolve(input.path);
    const existing = this.getProjectByPath(resolvedPath);
    const now = new Date().toISOString();

    if (existing) {
      const updatedBadge = input.badgeState ?? existing.badgeState;
      this.db
        .prepare(
          `UPDATE projects SET unit_id = ?, badge_state = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.unitId, updatedBadge, now, existing.id);
      const sessions = this.listSessions(existing.id);
      const defaultSessionId =
        sessions[0]?.id ?? this.createSession(existing.id, 'Main Workspace Session').id;
      return {
        project: {
          ...existing,
          unitId: input.unitId,
          badgeState: updatedBadge,
          updatedAt: now,
        },
        defaultSessionId,
      };
    }

    const id = `proj-${crypto.randomUUID().slice(0, 8)}`;
    const name = input.name ?? path.basename(resolvedPath);
    const badgeState = input.badgeState ?? 'idle';

    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, unit_id, badge_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, resolvedPath, input.unitId, badgeState, now, now);

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
    patch: { badgeState?: LiveBadgeState },
  ): RegisteredProject | null {
    const proj = this.getProject(projectId);
    if (!proj) return null;
    const badgeState = patch.badgeState ?? proj.badgeState;
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE projects SET badge_state = ?, updated_at = ? WHERE id = ?`)
      .run(badgeState, now, projectId);
    return { ...proj, badgeState, updatedAt: now };
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
  }): ChatMessageRecord {
    const id = `msg-${crypto.randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO messages (id, project_id, session_id, role, content, turn_blocks_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.sessionId,
        input.role,
        input.content,
        input.turnBlocks ? JSON.stringify(input.turnBlocks) : null,
        createdAt,
      );

    return {
      id,
      projectId: input.projectId,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      turnBlocks: input.turnBlocks,
      createdAt,
    };
  }

  // Removed: listPendingAlerts (orchestrator-only)
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
    return [];
  }

  // Removed: resolveDecisionCard (orchestrator-only)
  public resolveDecisionCard(messageId: string, resolution: unknown): void {
    // No-op: decision cards removed
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
      createdAt: r.created_at!,
    }));
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

  // Removed: Provider settings management (orchestrator-only)
  // These methods managed AI provider configuration for the conversational orchestrator
  // They are no longer needed as the app becomes a pure terminal supervisor

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
