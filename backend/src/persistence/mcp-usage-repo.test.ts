import { describe, it, expect } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createMcpUsageRepo } from './mcp-usage-repo.js';
import type { McpServerUsageRecord } from '../mcp-usage/mcp-usage-contract.js';

function record(overrides: Partial<McpServerUsageRecord> = {}): McpServerUsageRecord {
  return {
    featureId: 'f1',
    sessionId: 's1',
    provider: 'copilot',
    server: 'filesystem',
    calls: 2,
    inputBytes: 100,
    outputBytes: 200,
    durationMs: 30,
    recordedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function rows(db: ReturnType<typeof createDatabase>) {
  return db
    .prepare('SELECT feature_id, session_id, server, calls FROM mcp_server_usage ORDER BY id')
    .all() as Array<Record<string, unknown>>;
}

describe('mcp-usage-repo', () => {
  it('appends one row per recorded slice', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createMcpUsageRepo(db);
    repo.record(record());
    repo.record(record({ server: 'github', calls: 1 }));
    expect(rows(db)).toHaveLength(2);
    db.close();
  });

  it('stores a null session id', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createMcpUsageRepo(db);
    repo.record(record({ sessionId: null }));
    expect(rows(db)[0].session_id).toBeNull();
    db.close();
  });

  it('deletes by feature', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createMcpUsageRepo(db);
    repo.record(record({ featureId: 'f1' }));
    repo.record(record({ featureId: 'f2' }));
    repo.deleteByFeature('f1');
    expect(rows(db).map((r) => r.feature_id)).toEqual(['f2']);
    db.close();
  });

  it('deletes by session', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createMcpUsageRepo(db);
    repo.record(record({ sessionId: 's1' }));
    repo.record(record({ sessionId: 's2' }));
    repo.deleteBySession('s1');
    expect(rows(db).map((r) => r.session_id)).toEqual(['s2']);
    db.close();
  });
});
