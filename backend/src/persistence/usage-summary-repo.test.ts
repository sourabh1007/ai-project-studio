import { describe, it, expect } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createUsageRepo } from './usage-repo.js';
import { createSessionRepo } from './session-repo.js';
import { createUsageSummaryRepo } from './usage-summary-repo.js';
import { createUsageSummaryService } from '../usage-summary/usage-summary-service.js';
import type { Session } from '../session/session-contract.js';
import type { StoredUsage } from '../usage/usage-repo-port.js';

const session = (id: string, featureId: string): Session => ({
  id, featureId, name: null, provider: 'github', requestedModel: 'auto', resolvedModel: null,
  status: 'completed', kind: 'dev', scope: 'feature', prompt: 'p', usageFilePath: `u/${id}.jsonl`,
  createdAt: '2025-01-01T00:00:00.000Z', startedAt: null, endedAt: null, exitCode: 0,
});

const usage = (sessionId: string, featureId: string, o: Partial<StoredUsage> = {}): StoredUsage => ({
  sessionId, featureId, turnIndex: 0, kind: 'dev', provider: 'github', requestedModel: 'auto',
  resolvedModel: 'gpt-5.4', operation: 'chat', inputTokens: 10, outputTokens: 2, reasoningOutputTokens: 1,
  cost: 1, credits: 1, nanoAiu: 100, serviceRequestId: `r-${sessionId}-${o.turnIndex ?? 0}`,
  startedAt: '2025-01-01T00:00:00.000Z', endedAt: '2025-01-01T00:00:01.000Z', ...o,
});

describe('usage summary repo (db integration)', () => {
  it('reads features/groups/sessions and groups usage per feature+session across live, meta and retained rows', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const feature = (id: string, pf: string | null, pg: string | null) =>
      db.prepare("INSERT INTO features (id, name, description, created_at, parent_feature_id, parent_group_id) VALUES (?, ?, '', 'x', ?, ?)").run(id, id, pf, pg);
    feature('root', null, null);
    feature('child', 'root', null);
    db.prepare("INSERT INTO feature_groups (id, feature_id, parent_group_id, kind, name, created_at) VALUES ('g1', 'root', NULL, 'subcategory', 'g', 'x')").run();
    const sessions = createSessionRepo(db);
    for (const [id, f] of [['live', 'root'], ['empty', 'root'], ['zero', 'child'], ['skip-other-kind', 'root']]) sessions.save(session(id, f));
    db.prepare("UPDATE sessions SET group_id = 'g1' WHERE id = 'live'").run();
    createUsageRepo(db).saveAll([
      usage('live', 'root', { turnIndex: 0 }),
      usage('live', 'root', { turnIndex: 1, credits: null, nanoAiu: null, cost: null }),
      usage('zero', 'child', { credits: 0, cost: 0, nanoAiu: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }),
      usage('skip-other-kind', 'root', { kind: 'other' as StoredUsage['kind'], credits: 999 }),
    ]);
    db.prepare("INSERT INTO meta_usage_records (session_id, feature_id, provider_id, requested_model, transport, input_tokens, output_tokens, nano_aiu, credits, captured_at) VALUES ('warm1', 'root', 'github', 'auto', 'warm-acp', 5, 1, 50, 2, 'x')").run();
    db.prepare("INSERT INTO meta_usage_records (session_id, feature_id, provider_id, requested_model, transport, captured_at) VALUES ('warm2', 'root', 'github', 'auto', 'warm-acp', 'x')").run();
    const retain = (id: string, sessionId: string, credits: number) =>
      db.prepare(
        `INSERT INTO retained_usage (id, feature_id, feature_name, session_id, session_kind, scope, source,
          reason, provider, resolved_model, day, sessions, input_tokens, output_tokens, reasoning_output_tokens,
          cost, credits, nano_aiu, retained_at)
         VALUES (?, 'root', 'F', ?, 'dev', 'feature', 'cli', 'session-deleted', 'github', 'gpt-5.4', '2025-03-01', 1,
          10, 2, 1, 0, ?, 5, '2025-03-02T00:00:00.000Z')`,
      ).run(id, sessionId, credits);
    retain('r1', 'gone', 3);
    retain('r2', 'live', 4); // same session id as a live one: merged into one row, charges summed

    const reader = createUsageSummaryRepo(db, { rollupKinds: ['dev', 'meta'] } as never);
    expect(reader.features().map((f) => f.id).sort()).toEqual(['child', 'root']);
    expect(reader.features().find((f) => f.id === 'child')?.parentFeatureId).toBe('root');
    expect(reader.groups()).toEqual([{ id: 'g1', featureId: 'root', parentGroupId: null }]);
    expect(reader.sessions().find((s) => s.id === 'live')).toMatchObject({ featureId: 'root', groupId: 'g1' });

    const rows = reader.usage();
    const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r]));
    expect(rows).toHaveLength(5); // live(merged), zero, warm1, warm2, gone — 'other' kind excluded
    expect(byId['skip-other-kind']).toBeUndefined();
    expect(byId.live).toMatchObject({ sessions: 1, inputTokens: 30, credits: null, knownCredits: 5, unavailableCharges: 1 });
    expect(byId.zero).toMatchObject({ credits: 0, inputTokens: 0 });
    expect(byId.zero.unavailableCharges).toBeUndefined();
    expect(byId.warm1).toMatchObject({ credits: 2, inputTokens: 5 });
    expect(byId.warm2).toMatchObject({ credits: null, inputTokens: 0, unavailableCharges: 1 });
    expect(byId.gone).toMatchObject({ credits: 3 });

    const summary = createUsageSummaryService({ reader }).summary();
    expect(summary.features.root.groups.g1.totals.sessions).toBe(1);
    expect(summary.features.root.totals.sessions).toBe(7); // live, gone, warm1, warm2, 2 usage-less sessions, child's zero session
    expect(summary.features.root.sessionsWithoutUsage).toBe(2);
    expect(summary.features.child.state).toBe('complete');
    expect(summary.features.root.state).toBe('partial');
    db.close();
  });
});
