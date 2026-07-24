import { describe, it, expect } from 'vitest';
import { createDatabase } from './connection.js';
import { SCHEMA_STATEMENTS } from './schema.js';

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
});
