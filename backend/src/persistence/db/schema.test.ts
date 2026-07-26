import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from './connection.js';
import { SCHEMA_STATEMENTS, applySchema } from './schema.js';

function sessionColumns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
    (c) => c.name,
  );
}

function skillsColumns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(skills)').all() as { name: string }[]).map(
    (c) => c.name,
  );
}

describe('db schema/connection', () => {
  it('creates all expected tables', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    db.close();
    expect(tables).toEqual(
      expect.arrayContaining([
        'features',
        'sessions',
        'usage_events',
        'transcripts',
        'summaries',
        'session_summaries',
        'skills',
        'skill_attachments',
        'feature_tasks',
      ]),
    );
  });

  it('is idempotent when applied twice', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    expect(() => {
      for (const stmt of SCHEMA_STATEMENTS) {
        db.exec(stmt);
      }
    }).not.toThrow();
    db.close();
  });

  it('adds the sessions.name column to a legacy database', () => {
    const db = new DatabaseSync(':memory:');
    // A pre-name-feature sessions table, missing the `name` column.
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      resolved_model TEXT,
      status TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT NOT NULL,
      usage_file_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      exit_code INTEGER
    )`);
    expect(sessionColumns(db)).not.toContain('name');
    applySchema(db);
    expect(sessionColumns(db)).toContain('name');
    // Idempotent: applying again does not attempt to re-add the column.
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });

  it('adds the skills.removal_instructions column to a legacy database', () => {
    const db = new DatabaseSync(':memory:');
    // A pre-removal-reaction skills table, missing the new column.
    db.exec(`CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      instructions TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    expect(skillsColumns(db)).not.toContain('removal_instructions');
    applySchema(db);
    expect(skillsColumns(db)).toContain('removal_instructions');
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });
});
