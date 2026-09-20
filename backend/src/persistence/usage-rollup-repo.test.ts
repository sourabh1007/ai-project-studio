import { describe, expect, it } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createUsageRepo } from './usage-repo.js';
import { createMetaUsageRepo } from './meta-usage-repo.js';
import { createSessionRepo } from './session-repo.js';
import { createUsageRollupRepo } from './usage-rollup-repo.js';
import { ideUsageDefaults } from '../ide-usage/config.js';
import type { StoredUsage } from '../usage/usage-repo-port.js';
import type { Session } from '../session/session-contract.js';

function usage(overrides: Partial<StoredUsage>): StoredUsage {
  return {
    sessionId: 's1',
    featureId: 'f1',
    turnIndex: 0,
    kind: 'dev',
    provider: 'github',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5.4',
    operation: 'chat',
    inputTokens: 100,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    cost: 0.3,
    credits: 1,
    nanoAiu: 1000,
    serviceRequestId: 'req',
    startedAt: '2026-01-01T00:00:02.000Z',
    endedAt: '2026-01-01T00:00:03.000Z',
    ...overrides,
  };
}

function session(id: string, scope: Session['scope'], kind: Session['kind']): Session {
  return {
    id,
    featureId: 'f1',
    name: null,
    provider: 'github',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'completed',
    kind,
    scope,
    prompt: 'p',
    usageFilePath: `usage/${id}.jsonl`,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    exitCode: 0,
  };
}

function insertRetained(
  db: ReturnType<typeof createDatabase>,
  overrides: Record<string, unknown>,
): void {
  const cols = {
    id: 'r1',
    feature_id: 'f1',
    feature_name: 'Gone',
    session_id: 'deleted',
    session_kind: 'dev',
    scope: 'feature',
    source: 'cli',
    reason: 'feature-deleted',
    provider: 'github',
    resolved_model: 'gpt-5.4',
    day: '2025-12-01',
    sessions: 1,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    cost: 0,
    credits: 7,
    nano_aiu: 0,
    purpose: null,
    label: null,
    retained_at: '2025-12-02T00:00:00.000Z',
    ...overrides,
  };
  db.prepare(
    `INSERT INTO retained_usage (
      id, feature_id, feature_name, session_id, session_kind, scope, source,
      reason, provider, resolved_model, day, sessions, input_tokens,
      output_tokens, reasoning_output_tokens, cost, credits, nano_aiu,
      purpose, label, retained_at
    ) VALUES (
      $id, $feature_id, $feature_name, $session_id, $session_kind, $scope, $source,
      $reason, $provider, $resolved_model, $day, $sessions, $input_tokens,
      $output_tokens, $reasoning_output_tokens, $cost, $credits, $nano_aiu,
      $purpose, $label, $retained_at
    )`,
  ).run(cols);
}

function insertMcp(
  db: ReturnType<typeof createDatabase>,
  overrides: Record<string, unknown>,
): void {
  const cols = {
    feature_id: 'f1',
    session_id: 's1',
    provider: 'github',
    server: 'srv',
    calls: 1,
    input_bytes: 10,
    output_bytes: 20,
    duration_ms: 5,
    recorded_at: '2026-01-01T00:00:04.000Z',
    ...overrides,
  };
  db.prepare(
    `INSERT INTO mcp_server_usage (
      feature_id, session_id, provider, server, calls,
      input_bytes, output_bytes, duration_ms, recorded_at
    ) VALUES (
      $feature_id, $session_id, $provider, $server, $calls,
      $input_bytes, $output_bytes, $duration_ms, $recorded_at
    )`,
  ).run(cols);
}

function seed() {
  const db = createDatabase({ databasePath: ':memory:' });
  const sessions = createSessionRepo(db);
  sessions.save(session('s1', 'feature', 'dev'));
  sessions.save(session('s5', 'internal', 'meta'));
  createUsageRepo(db).saveAll([
    usage({ sessionId: 's1', credits: 1 }),
    usage({ sessionId: 's5', kind: 'meta', credits: 500, startedAt: '2026-01-02T00:00:00.000Z' }),
  ]);
  createMetaUsageRepo(db).save({
    sessionId: 'warm-1',
    featureId: 'f1',
    providerId: 'copilot',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5.4',
    transport: 'warm-acp',
    providerSessionId: 'p1',
    purpose: 'review',
    label: null,
    inputTokens: 1,
    outputTokens: 1,
    nanoAiu: 42,
    credits: 3,
    capturedAt: '2026-01-03T00:00:00.000Z',
  });
  insertRetained(db, { id: 'r-cli', source: 'cli', scope: 'feature', credits: 7 });
  insertRetained(db, { id: 'r-meta', source: 'meta', scope: 'internal', credits: 9, session_id: 'del2' });
  // MCP tool-call I/O: a dev-session server, a meta-session server, and an
  // unattributed (NULL session) server — to exercise the scope predicates.
  insertMcp(db, { session_id: 's1', server: 'github', calls: 2 });
  insertMcp(db, { session_id: 's5', server: 'azure', calls: 5 });
  insertMcp(db, { session_id: null, server: 'ambient', calls: 1 });
  return { db, reader: createUsageRollupRepo(db, ideUsageDefaults) };
}

function totalCredits(rows: { credits: number }[]): number {
  return rows.reduce((sum, row) => sum + row.credits, 0);
}

describe('createUsageRollupRepo', () => {
  it('workspace excludes internal + meta but keeps retained feature usage', () => {
    const { db, reader } = seed();
    const rows = reader.workspaceDays();
    // s1 (1) + retained cli feature (7); NOT s5 internal (500), NOT meta records/retained-meta.
    expect(totalCredits(rows)).toBeCloseTo(8);
    db.close();
  });

  it('ide includes meta-kind turns, all warm-ACP records and retained IDE usage', () => {
    const { db, reader } = seed();
    const rows = reader.ideDays();
    // s5 meta turn (500) + warm record (3) + retained meta (9).
    expect(totalCredits(rows)).toBeCloseTo(512);
    db.close();
  });

  it('feature rolls up every source attributed to the feature', () => {
    const { db, reader } = seed();
    const rows = reader.featureDays('f1');
    // s1 (1) + s5 (500) + warm record (3) + retained cli (7). retained-meta belongs
    // to a different (deleted) session but same feature_id f1, so +9.
    expect(totalCredits(rows)).toBeCloseTo(520);
    expect(reader.featureDays('other')).toEqual([]);
    db.close();
  });

  it('workspace MCP keeps non-internal + unattributed servers, drops meta', () => {
    const { db, reader } = seed();
    const rows = reader.workspaceMcpServers();
    // github (dev session s1) + ambient (NULL session); NOT azure (meta session s5).
    expect(rows.map((r) => r.server)).toEqual(['ambient', 'github']);
    expect(rows.reduce((n, r) => n + r.calls, 0)).toBe(3);
    db.close();
  });

  it('ide MCP keeps only servers driven by metasessions', () => {
    const { db, reader } = seed();
    const rows = reader.ideMcpServers();
    // azure (meta session s5) only; s1 is a dev turn, ambient has no session.
    expect(rows.map((r) => r.server)).toEqual(['azure']);
    expect(rows[0].calls).toBe(5);
    db.close();
  });

  it('feature MCP rolls up every server tagged with the feature id', () => {
    const { db, reader } = seed();
    expect(reader.featureMcpServers('f1').map((r) => r.server)).toEqual([
      'ambient',
      'azure',
      'github',
    ]);
    expect(reader.featureMcpServers('other')).toEqual([]);
    db.close();
  });
});
