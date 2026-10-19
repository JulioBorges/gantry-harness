import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { HarnessStateStore } from '../src/server/stateStore.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('opens a harness database created before decision_card_json and still lists alerts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-legacy-db-'));
  roots.push(root);
  const dbPath = path.join(root, 'harness', 'harness.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      unit_id TEXT NOT NULL,
      badge_state TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      slug TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      turn_blocks_json TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO projects (id, name, path, unit_id, badge_state, created_at, updated_at)
    VALUES ('proj-1', 'demo', '/tmp/demo', 'unit-1', 'idle', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO messages (id, project_id, session_id, role, content, created_at)
    VALUES ('msg-1', 'proj-1', 'sess-1', 'user', 'hello', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const store = new HarnessStateStore(root);
  expect(store.listPendingAlerts()).toEqual([]);
  expect(store.listMessages('proj-1')).toEqual([
    expect.objectContaining({ id: 'msg-1', content: 'hello', decisionCard: undefined }),
  ]);
  expect(store.listProjects()[0]?.lifecycleState).toBe('idle');

  const reopened = new HarnessStateStore(root);
  expect(reopened.listPendingAlerts()).toEqual([]);
  const inspected = new DatabaseSync(store.dbPath);
  const columns = inspected.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
  inspected.close();
  expect(columns.map((column) => column.name)).toContain('decision_card_json');
});
