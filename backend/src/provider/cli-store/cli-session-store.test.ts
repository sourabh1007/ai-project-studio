import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliSessionStore, deriveTitle } from './cli-session-store.js';

let dir: string;
let dbPath: string;

const baseDeps = {
  provider: 'agency',
  limit: 50,
  maxTitleChars: 80,
  emptyTitlePlaceholder: '(untitled session)',
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-import-'));
  dbPath = join(dir, 'session-store.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, branch TEXT,
      summary TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER,
      user_message TEXT, assistant_response TEXT, timestamp TEXT
    );
    CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER,
      model TEXT, created_at TEXT
    );
    -- Rich session with summary, turns, model.
    INSERT INTO sessions VALUES
      ('s1', 'C:/proj', 'org/repo', 'main', 'Add auth', '2025-01-01T00:00:00Z', '2025-01-03T00:00:00Z');
    INSERT INTO turns VALUES
      (1, 's1', 0, 'first message', 'ok', '2025-01-01T00:00:00Z'),
      (2, 's1', 1, 'second', 'ok', '2025-01-02T00:00:00Z');
    INSERT INTO assistant_usage_events VALUES
      (1, 's1', 0, 'gpt-5.4', '2025-01-01T00:00:01Z'),
      (2, 's1', 1, 'claude-opus-4.8', '2025-01-02T00:00:01Z');
    -- No summary but has a first message; no usage rows -> model null.
    INSERT INTO sessions VALUES
      ('s2', NULL, NULL, NULL, NULL, '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');
    INSERT INTO turns VALUES (3, 's2', 0, 'hello there', 'hi', '2025-01-01T00:00:00Z');
    -- Empty session: no summary, no turns -> filtered out.
    INSERT INTO sessions VALUES
      ('s3', NULL, NULL, NULL, NULL, '2025-01-01T00:00:00Z', '2025-01-04T00:00:00Z');
  `);
  db.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createCliSessionStore', () => {
  it('reports availability from the file on disk', () => {
    expect(createCliSessionStore({ ...baseDeps, databasePath: dbPath }).available()).toBe(true);
    expect(
      createCliSessionStore({ ...baseDeps, databasePath: join(dir, 'missing.db') }).available(),
    ).toBe(false);
  });

  it('lists non-empty sessions newest-first with derived fields', () => {
    const store = createCliSessionStore({ ...baseDeps, databasePath: dbPath });
    const rows = store.listImportable();
    // s3 (empty) filtered out; ordered by updated_at desc: s1 then s2.
    expect(rows.map((r) => r.externalId)).toEqual(['s1', 's2']);
    expect(rows[0]).toEqual({
      externalId: 's1',
      provider: 'agency',
      title: 'Add auth',
      cwd: 'C:/proj',
      repository: 'org/repo',
      branch: 'main',
      model: 'claude-opus-4.8',
      messageCount: 2,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-03T00:00:00Z',
    });
    expect(rows[1]).toMatchObject({
      externalId: 's2',
      title: 'hello there',
      model: null,
      messageCount: 1,
    });
  });

  it('respects the limit', () => {
    const store = createCliSessionStore({ ...baseDeps, databasePath: dbPath, limit: 1 });
    expect(store.listImportable()).toHaveLength(1);
  });

  it('returns empty when the file is missing', () => {
    const store = createCliSessionStore({ ...baseDeps, databasePath: join(dir, 'missing.db') });
    expect(store.listImportable()).toEqual([]);
  });

  it('degrades to empty when the file is not a valid database', () => {
    const badPath = join(dir, 'corrupt.db');
    writeFileSync(badPath, 'not a sqlite database');
    const store = createCliSessionStore({ ...baseDeps, databasePath: badPath });
    expect(store.listImportable()).toEqual([]);
  });

  it('degrades to empty when the store cannot be opened', () => {
    const store = createCliSessionStore({ ...baseDeps, databasePath: dir });
    expect(store.listImportable()).toEqual([]);
  });
});

describe('deriveTitle', () => {
  it('prefers the summary', () => {
    expect(deriveTitle({ summary: 'Sum', first_message: 'msg' }, 80, 'x')).toBe('Sum');
  });

  it('falls back to the first line of the first message', () => {
    expect(
      deriveTitle({ summary: '   ', first_message: 'line one\nline two' }, 80, 'x'),
    ).toBe('line one');
  });

  it('uses the placeholder when nothing is available', () => {
    expect(deriveTitle({ summary: null, first_message: null }, 80, 'none')).toBe('none');
  });

  it('truncates long titles with an ellipsis', () => {
    expect(deriveTitle({ summary: 'abcdefghij', first_message: null }, 5, 'x')).toBe('abcd…');
  });
});
