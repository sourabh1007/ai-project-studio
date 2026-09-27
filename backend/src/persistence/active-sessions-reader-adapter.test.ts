import { describe, expect, it } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createActiveSessionsReader } from './active-sessions-reader-adapter.js';

describe('active sessions projection', () => {
  it('reads running internal and normal instances without prompts or history', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    try {
      db.prepare(`INSERT INTO features (id, name, description, created_at) VALUES ('f','Feature','','t')`).run();
      const insert = db.prepare(`INSERT INTO sessions (id, feature_id, provider, requested_model, status, kind, scope, prompt, usage_file_path, created_at)
        VALUES (?, 'f', 'copilot', 'auto', ?, ?, ?, 'SECRET PROMPT', 'SECRET PATH', 't')`);
      insert.run('user', 'running', 'dev', 'feature');
      insert.run('meta', 'running', 'meta', 'internal');
      insert.run('done', 'completed', 'dev', 'feature');
      const rows = createActiveSessionsReader(db)();
      expect(rows.map((row) => row.id)).toEqual(['meta', 'user']);
      expect(JSON.stringify(rows)).not.toContain('SECRET');
      expect(rows[0]).toMatchObject({ kind: 'meta', scope: 'internal', featureId: 'f' });
    } finally { db.close(); }
  });
});
