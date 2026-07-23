import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCopilotHistoryDb } from './copilot-history-db.js';

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-history-'));
  dbPath = join(dir, 'session-store.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT);
    CREATE TABLE checkpoints (
      session_id TEXT,
      checkpoint_number INTEGER,
      title TEXT,
      overview TEXT,
      created_at TEXT
    );
    INSERT INTO sessions (id, summary) VALUES ('s1', 'Summary one'), ('s2', NULL);
    INSERT INTO checkpoints VALUES ('s1', 1, 'T1', 'O1', '2024-01-01T00:00:00Z');
    INSERT INTO checkpoints VALUES ('s1', 2, 'T2', 'O2', '2024-01-02T00:00:00Z');
  `);
  db.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createCopilotHistoryDb', () => {
  it('reports availability from the file on disk', () => {
    expect(createCopilotHistoryDb({ databasePath: dbPath }).available()).toBe(
      true,
    );
    expect(
      createCopilotHistoryDb({
        databasePath: join(dir, 'missing.db'),
      }).available(),
    ).toBe(false);
  });

  it('reads session summaries for the requested ids', () => {
    const source = createCopilotHistoryDb({ databasePath: dbPath });
    const rows = source.sessionSummaries(['s1', 's2']);
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: 's1', summary: 'Summary one' },
        { id: 's2', summary: null },
      ]),
    );
  });

  it('reads checkpoints for the requested ids', () => {
    const source = createCopilotHistoryDb({ databasePath: dbPath });
    const rows = source.checkpoints(['s1']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ session_id: 's1', checkpoint_number: 1 });
  });

  it('returns empty for empty id lists without touching the file', () => {
    const source = createCopilotHistoryDb({ databasePath: dbPath });
    expect(source.sessionSummaries([])).toEqual([]);
    expect(source.checkpoints([])).toEqual([]);
  });

  it('returns empty when the file is missing', () => {
    const source = createCopilotHistoryDb({
      databasePath: join(dir, 'missing.db'),
    });
    expect(source.sessionSummaries(['s1'])).toEqual([]);
    expect(source.checkpoints(['s1'])).toEqual([]);
  });

  it('degrades to empty when the file is not a valid database', () => {
    const badPath = join(dir, 'corrupt.db');
    writeFileSync(badPath, 'not a sqlite database');
    const source = createCopilotHistoryDb({ databasePath: badPath });
    expect(source.sessionSummaries(['s1'])).toEqual([]);
    expect(source.checkpoints(['s1'])).toEqual([]);
  });

  it('degrades to empty when the store cannot be opened', () => {
    // A directory exists but cannot be opened as a database.
    const source = createCopilotHistoryDb({ databasePath: dir });
    expect(source.sessionSummaries(['s1'])).toEqual([]);
    expect(source.checkpoints(['s1'])).toEqual([]);
  });
});
