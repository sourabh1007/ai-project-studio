import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createMcpLogOwners } from './mcp-log-owners.js';

const dbs: ReturnType<typeof createDatabase>[] = [];
function fixture() {
  const db = createDatabase({ databasePath: ':memory:' });
  dbs.push(db);
  db.exec(`INSERT INTO sessions (id, feature_id, provider, requested_model, status, kind, scope, prompt, usage_file_path, created_at)
    VALUES ('s1', 'f', 'agency', 'auto', 'running', 'chat', 'feature', '', '', '2026-09-26'),
      ('s2', 'f', 'claude', 'auto', 'running', 'chat', 'feature', '', '', '2026-09-26'),
      ('s3', 'f', 'copilot', 'auto', 'running', 'meta', 'internal', '', '', '2026-09-26');
    INSERT INTO meta_operations (operation_id, feature_id, provider_id, session_id, provider_session_id,
      transport, created_at, updated_at, started_at, finished_at)
    VALUES ('m1', 'first', 'copilot', 'app-1', 'warm', 'warm-acp', '2026-09-26T09:00:00Z', 't',
      '2026-09-26T09:00:01Z', '2026-09-26T10:00:00Z'),
      ('m2', 'second', 'copilot', 'app-2', 'warm', 'warm-acp', '2026-09-26T11:00:00Z', 't',
      NULL, NULL),
      ('m3', 'skip', 'claude', 'app-3', 'other', 'warm-acp', '2026-09-26T11:00:00Z', 't', NULL, NULL);`);
  return { db, owners: createMcpLogOwners(db) };
}
afterEach(() => dbs.splice(0).forEach((db) => db.close()));

describe('app-owned CLI MCP attribution', () => {
  it('pages only supported local CLI identities and deduplicates reused warm sessions', () => {
    const { owners } = fixture();
    expect(owners.list('', 2)).toEqual([
      { key: 'agency:s1', provider: 'agency', sessionId: 's1' },
      { key: 'copilot:s3', provider: 'copilot', sessionId: 's3' },
    ]);
    expect(owners.list('copilot:s3', 2)).toEqual([{ key: 'copilot:warm', provider: 'copilot', sessionId: 'warm' }]);
    expect(owners.list('copilot:warm', 2)).toEqual([]);
  });
  it('uses direct app session scope and rechecks deletion', () => {
    const { db, owners } = fixture();
    const source = owners.list('', 1)[0];
    expect(owners.resolve(source, '2026-09-26T12:00:00Z')).toEqual({ featureId: 'f', sessionId: 's1', scope: 'feature' });
    db.exec("DELETE FROM sessions WHERE id = 's1'");
    expect(owners.resolve(source, '2026-09-26T12:00:00Z')).toBeNull();
    expect(owners.resolve({ ...source, provider: 'copilot', sessionId: 's3' }, '2026-09-26T12:00:00Z')?.scope).toBe('internal');
  });
  it('attributes warm calls by operation window, never by the latest feature', () => {
    const { owners } = fixture();
    const source = { key: 'copilot:warm', provider: 'copilot', sessionId: 'warm' };
    expect(owners.resolve(source, '2026-09-26T09:30:00Z')).toEqual({ featureId: 'first', sessionId: 'app-1', scope: 'internal' });
    expect(owners.resolve(source, '2026-09-26T10:30:00Z')).toBeNull();
    expect(owners.resolve(source, '2026-09-26T11:30:00Z')).toEqual({ featureId: 'second', sessionId: 'app-2', scope: 'internal' });
    expect(owners.resolve(source, 'invalid')).toBeNull();
  });
  it('rejects overlapping attribution and deleted operation windows', () => {
    const { db, owners } = fixture();
    const source = { key: 'copilot:warm', provider: 'copilot', sessionId: 'warm' };
    db.exec("UPDATE meta_operations SET finished_at = NULL WHERE operation_id = 'm1'");
    expect(owners.resolve(source, '2026-09-26T12:00:00Z')).toBeNull();
    db.exec("DELETE FROM meta_operations WHERE provider_session_id = 'warm'");
    expect(owners.resolve(source, '2026-09-26T12:00:00Z')).toBeNull();
  });
  it('falls back to physical session identity when no application identity was persisted', () => {
    const { db, owners } = fixture();
    db.exec("UPDATE meta_operations SET session_id = NULL WHERE operation_id = 'm1'");
    expect(owners.resolve({ key: 'copilot:warm', provider: 'copilot', sessionId: 'warm' }, '2026-09-26T09:30:00Z')?.sessionId).toBe('warm');
  });
});
