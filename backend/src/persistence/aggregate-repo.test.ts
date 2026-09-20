import { describe, it, expect } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createUsageRepo } from './usage-repo.js';
import { createAggregateRepo } from './aggregate-repo.js';
import { createSessionRepo } from './session-repo.js';
import { aggregationDefaults } from '../aggregation/config.js';
import type { Session } from '../session/session-contract.js';
import type { StoredUsage } from '../usage/usage-repo-port.js';

function usage(overrides: Partial<StoredUsage>): StoredUsage {
  return {
    sessionId: 's1',
    featureId: 'f1',
    turnIndex: 0,
    kind: 'dev',
    provider: 'github',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5.4-mini',
    operation: 'chat',
    inputTokens: 100,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    cost: 0.33,
    credits: 0.33,
    nanoAiu: 1000,
    serviceRequestId: 'req',
    startedAt: '2025-01-01T00:00:02.000Z',
    endedAt: '2025-01-01T00:00:03.000Z',
    ...overrides,
  };
}

function session(
  id: string,
  featureId: string,
  scope: Session['scope'] = 'feature',
): Session {
  return {
    id,
    featureId,
    name: null,
    provider: 'github',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'completed',
    kind: id.startsWith('s3') || id.startsWith('s5') ? 'meta' : 'dev',
    scope,
    prompt: 'p',
    usageFilePath: `usage/${id}.jsonl`,
    createdAt: '2025-01-01T00:00:00.000Z',
    startedAt: '2025-01-01T00:00:00.000Z',
    endedAt: '2025-01-01T00:01:00.000Z',
    exitCode: 0,
  };
}

function seed() {
  const db = createDatabase({ databasePath: ':memory:' });
  const sessions = createSessionRepo(db);
  sessions.save(session('s1', 'f1'));
  sessions.save(session('s2', 'f1'));
  sessions.save(session('s3', 'f1'));
  sessions.save(session('s4', 'f2'));
  sessions.save(session('s5', 'f1', 'internal'));
  const repo = createUsageRepo(db);
  repo.saveAll([
    usage({ sessionId: 's1', turnIndex: 0, resolvedModel: 'gpt-5.4-mini', provider: 'github', inputTokens: 100, credits: 0.33, startedAt: '2025-01-01T00:00:00.000Z' }),
    usage({ sessionId: 's1', turnIndex: 1, resolvedModel: 'gpt-5.4', provider: 'github', inputTokens: 200, credits: 1, startedAt: '2025-01-01T00:00:10.000Z' }),
    usage({ sessionId: 's2', turnIndex: 0, resolvedModel: 'claude-sonnet-4.5', provider: 'agency', inputTokens: 50, credits: 2, startedAt: '2025-01-02T00:00:00.000Z' }),
    // meta session usage — now included in rollups
    usage({ sessionId: 's3', turnIndex: 0, kind: 'meta', credits: 99, inputTokens: 999, startedAt: '2025-01-03T00:00:00.000Z' }),
    // different feature
    usage({ sessionId: 's4', featureId: 'f2', turnIndex: 0, credits: 5, startedAt: '2025-01-01T00:00:00.000Z' }),
    // internal repository analysis — IDE AI usage, never development analytics.
    usage({
      sessionId: 's5',
      turnIndex: 0,
      kind: 'meta',
      credits: 500,
      inputTokens: 5000,
      startedAt: '2025-02-01T00:00:00.000Z',
    }),
  ]);
  return { db, reader: createAggregateRepo(db, aggregationDefaults) };
}

describe('aggregate-repo', () => {
  it('feature totals include dev, meta and internal IDE work but exclude other features', () => {
    const { db, reader } = seed();
    const totals = reader.featureTotals('f1');
    // s1, s2, s3 (dev/meta) plus s5 (internal IDE work under this feature).
    expect(totals.sessions).toBe(4);
    expect(totals.credits).toBeCloseTo(0.33 + 1 + 2 + 99 + 500);
    expect(totals.inputTokens).toBe(6349);
    db.close();
  });

  it('breaks down by model', () => {
    const { db, reader } = seed();
    const byModel = reader.byModel('f1');
    expect(byModel.map((m) => m.model)).toEqual([
      'claude-sonnet-4.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
    db.close();
  });

  it('breaks down by provider', () => {
    const { db, reader } = seed();
    const byProvider = reader.byProvider('f1');
    expect(byProvider.map((p) => p.provider)).toEqual(['agency', 'github']);
    expect(byProvider.find((p) => p.provider === 'github')?.sessions).toBe(3);
    db.close();
  });

  it('breaks down by day', () => {
    const { db, reader } = seed();
    const byDay = reader.byDay('f1');
    expect(byDay.map((d) => d.day)).toEqual([
      '2025-01-01',
      '2025-01-02',
      '2025-01-03',
      '2025-02-01',
    ]);
    db.close();
  });

  it('breaks down by session', () => {
    const { db, reader } = seed();
    const bySession = reader.bySession('f1');
    expect(bySession.map((s) => s.sessionId)).toEqual(['s1', 's2', 's3', 's5']);
    db.close();
  });

  it('computes workspace totals across features including meta', () => {
    const { db, reader } = seed();
    const totals = reader.workspaceTotals();
    expect(totals.credits).toBeCloseTo(0.33 + 1 + 2 + 99 + 5);
    db.close();
  });

  it('keeps internal IDE work out of the workspace-wide billable total', () => {
    const { db, reader } = seed();
    // Feature analytics DO surface internal IDE work (so a feature's usage tree
    // reconciles with the credits its sessions spent)...
    expect(reader.featureTotals('f1').credits).toBeCloseTo(0.33 + 1 + 2 + 99 + 500);
    expect(reader.bySession('f1').map((row) => row.sessionId)).toContain('s5');
    expect(reader.byDay('f1').map((row) => row.day)).toContain('2025-02-01');
    // ...but the workspace-wide total excludes internal-scope usage.
    expect(reader.workspaceTotals().credits).not.toBe(500);
    expect(reader.workspaceTotals().credits).toBeCloseTo(0.33 + 1 + 2 + 99 + 5);
    db.close();
  });

  it('folds warm-ACP meta_usage_records into per-feature rollups', () => {
    const { db, reader } = seed();
    db.prepare(
      `INSERT INTO meta_usage_records (
         session_id, feature_id, provider_id, requested_model, resolved_model,
         transport, provider_session_id, purpose, label, input_tokens,
         output_tokens, nano_aiu, credits, captured_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'warm-1', 'f1', 'copilot', 'auto', 'warm-model', 'warm-acp', null,
      'meta', 'Bug Bash', 10, 5, 2000, 3.5, '2025-01-04T00:00:00.000Z',
    );
    const totals = reader.featureTotals('f1');
    expect(totals.credits).toBeCloseTo(0.33 + 1 + 2 + 99 + 500 + 3.5);
    expect(totals.inputTokens).toBe(6349 + 10);
    expect(reader.byModel('f1').some((m) => m.model === 'warm-model')).toBe(true);
    expect(reader.byProvider('f1').some((p) => p.provider === 'copilot')).toBe(true);
    expect(reader.byDay('f1').map((d) => d.day)).toContain('2025-01-04');
    db.close();
  });

  it('lists warm-ACP agent runs per feature with their labels', () => {
    const { db, reader } = seed();
    const insert = db.prepare(
      `INSERT INTO meta_usage_records (
         session_id, feature_id, provider_id, requested_model, resolved_model,
         transport, provider_session_id, purpose, label, input_tokens,
         output_tokens, nano_aiu, credits, captured_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      'acp-a', 'f1', 'copilot', 'auto', null, 'warm-acp', null, null,
      'Bug bash · Tester 1', 10, 5, null, null, '2025-01-04T00:00:00.000Z',
    );
    insert.run(
      'acp-b', 'f1', 'copilot', 'auto', null, 'warm-acp', null, null,
      'Bug bash · lead report', 20, 8, null, null, '2025-01-05T00:00:00.000Z',
    );
    insert.run(
      'acp-c', 'f2', 'copilot', 'auto', null, 'warm-acp', null, null,
      'Other feature', 1, 1, null, null, '2025-01-04T00:00:00.000Z',
    );

    const agents = reader.warmAgentSessions('f1');
    expect(agents).toEqual([
      { sessionId: 'acp-a', provider: 'copilot', label: 'Bug bash · Tester 1', capturedAt: '2025-01-04T00:00:00.000Z' },
      { sessionId: 'acp-b', provider: 'copilot', label: 'Bug bash · lead report', capturedAt: '2025-01-05T00:00:00.000Z' },
    ]);
    expect(reader.warmAgentSessions('f3')).toEqual([]);
    db.close();
  });

  it('rolls up proxy-measured MCP server I/O per feature', () => {
    const { db, reader } = seed();
    const insert = db.prepare(
      `INSERT INTO mcp_server_usage (
         feature_id, session_id, provider, server, calls,
         input_bytes, output_bytes, duration_ms, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('f1', 's1', 'copilot', 'filesystem', 2, 100, 400, 30, '2025-01-01T00:00:00.000Z');
    insert.run('f1', 's2', 'copilot', 'filesystem', 3, 50, 200, 20, '2025-01-02T00:00:00.000Z');
    insert.run('f1', 's1', 'copilot', 'github', 1, 10, 20, 5, '2025-01-01T00:00:00.000Z');
    insert.run('f2', 's4', 'copilot', 'filesystem', 9, 999, 999, 999, '2025-01-01T00:00:00.000Z');

    const byServer = reader.byMcpServer('f1');
    expect(byServer.map((s) => s.server)).toEqual(['filesystem', 'github']);
    const filesystem = byServer.find((s) => s.server === 'filesystem');
    expect(filesystem).toEqual({
      server: 'filesystem',
      calls: 5,
      inputBytes: 150,
      outputBytes: 600,
      durationMs: 50,
    });
    // Other features are excluded.
    expect(reader.byMcpServer('f3')).toEqual([]);
    db.close();
  });
});
