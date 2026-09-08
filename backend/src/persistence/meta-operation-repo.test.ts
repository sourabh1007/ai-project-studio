import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatementSync, type DatabaseSync } from 'node:sqlite';
import { createDatabase } from './db/connection.js';
import { createMetaOperationRepo } from './meta-operation-repo.js';
import { createMetaUsageRepo } from './meta-usage-repo.js';
import type { MetaOperation, MetaOperationRepo } from '../meta/meta-operation-contract.js';

function operation(operationId: string, overrides: Partial<MetaOperation> = {}): MetaOperation {
  return {
    operationId, featureId: 'f', automationId: 'a', originSessionId: 'origin', providerId: 'copilot',
    requestedModel: 'auto', resolvedModel: null, sessionId: 'last', providerSessionId: 'provider',
    sessionIds: ['first', 'last'], transport: 'warm-acp', state: 'running', outcome: 'unknown',
    purpose: null, label: null, resultText: null, errorMessage: null, usageState: 'unknown',
    usage: null, createdAt: 't', updatedAt: 't', startedAt: 't', finishedAt: null, ...overrides,
  };
}

describe('durable meta operation repository', () => {
  let db: DatabaseSync;
  let repo: MetaOperationRepo;
  beforeEach(() => { db = createDatabase({ databasePath: ':memory:' }); repo = createMetaOperationRepo(db); });
  afterEach(() => db.close());

  it('round-trips complete output and explicit usage while metadata pages exclude all result text', () => {
    const first = operation('1'); const second = operation('2', { featureId: 'g' });
    repo.create(first); repo.create(second);
    const done = { ...first, state: 'completed' as const, outcome: 'returned' as const, resultText: '<script>not executed</script>'.repeat(1000),
      usageState: 'recorded' as const, usage: { inputTokens: 1, outputTokens: 2, nanoAiu: 3, credits: 4 } };
    expect(repo.complete(done, null)).toBe(true);
    expect(repo.get('1')).toEqual(done);
    expect(repo.get('missing')).toBeNull();
    const all = vi.spyOn(StatementSync.prototype, 'all');
    try {
      const page = repo.listPage({}, null, 1);
      expect(page.nextCursor).toBe('1');
      expect(page.items[0]).toMatchObject({ hasResult: true, usageState: 'recorded' });
      expect(page.items[0]).not.toHaveProperty('resultText');
      expect(all.mock.results[0].value).toHaveLength(2);
      expect(all.mock.results[0].value[0]).not.toHaveProperty('result_text');
      expect(repo.listPage({}, page.nextCursor, 1)).toMatchObject({ items: [{ operationId: '2', hasResult: false }], nextCursor: null });
    } finally { all.mockRestore(); }
    expect(repo.listPage({}, '2', 1)).toEqual({ items: [], nextCursor: null });
  });

  it('filters independently and jointly by feature, automation, origin and all observed application sessions', () => {
    repo.create(operation('1')); repo.create(operation('2', { featureId: 'g', automationId: 'b', originSessionId: null, sessionIds: [], sessionId: null }));
    for (const filter of [{ featureId: 'f' }, { automationId: 'a' }, { sessionId: 'origin' }, { sessionId: 'first' }, { sessionId: 'last' }, { featureId: 'f', automationId: 'a', sessionId: 'first' }]) {
      expect(repo.listPage(filter, null, 10).items.map((item) => item.operationId)).toEqual(['1']);
    }
    expect(repo.listPage({ sessionId: 'provider' }, null, 10).items).toEqual([]);
    expect(repo.listPage({ featureId: 'f', automationId: 'b' }, null, 10).items).toEqual([]);
  });

  it('uses an indexed session and operation key range without scanning operation histories', () => {
    for (const id of ['1', '2', '3']) repo.create(operation(id));
    const prepare = vi.spyOn(db, 'prepare');
    const page = repo.listPage({ sessionId: 'origin' }, '1', 1);
    const sql = prepare.mock.calls[0][0];
    prepare.mockRestore();
    expect(page).toMatchObject({ items: [{ operationId: '2' }], nextCursor: '2' });
    expect(repo.listPage({ sessionId: 'origin' }, page.nextCursor, 1))
      .toMatchObject({ items: [{ operationId: '3' }], nextCursor: null });
    expect(sql).not.toContain('json_each');
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('origin', '1', 2)
      .map((row) => String(row.detail));
    expect(plan).toEqual(expect.arrayContaining([
      expect.stringMatching(/SEARCH identity USING COVERING INDEX.*session_id=\? AND operation_id>\?/),
      expect.stringMatching(/SEARCH operation USING INDEX.*operation_id=\?/),
    ]));
    expect(plan.some((step) => /SCAN|TEMP B-TREE/.test(step))).toBe(false);
  });

  it('atomically replaces deduplicated identities on updates and completion', () => {
    repo.create(operation('1', { originSessionId: 'first', sessionIds: ['first', 'first', 'last'] }));
    const identities = () => db.prepare('SELECT session_id FROM meta_operation_sessions ORDER BY session_id')
      .all().map((row) => row.session_id);
    expect(identities()).toEqual(['first', 'last']);
    expect(repo.update(operation('1', { originSessionId: null, sessionId: null, sessionIds: [] }))).toBe(true);
    expect(identities()).toEqual([]);
    expect(repo.listPage({ sessionId: 'first' }, null, 10).items).toEqual([]);
    expect(repo.complete(operation('1', { state: 'completed', resultText: 'done' }), null)).toBe(true);
    expect(identities()).toEqual(['first', 'last', 'origin']);
    expect(repo.update(operation('1', { sessionIds: ['must-not-appear'] }))).toBe(false);
    expect(identities()).toEqual(['first', 'last', 'origin']);
  });

  it('rolls back operation creation and updates when identity persistence fails', () => {
    const initial = operation('1'); repo.create(initial);
    db.exec(`CREATE TRIGGER usage.reject_meta_identity BEFORE INSERT ON meta_operation_sessions
      WHEN NEW.session_id = 'reject' BEGIN SELECT RAISE(FAIL, 'identity failed'); END`);
    expect(() => repo.create(operation('2', { sessionIds: ['reject'] }))).toThrow('identity failed');
    expect(repo.get('2')).toBeNull();
    expect(() => repo.update(operation('1', { originSessionId: null, sessionIds: ['reject'] })))
      .toThrow('identity failed');
    expect(repo.get('1')).toEqual(initial);
    expect(repo.listPage({ sessionId: 'origin' }, null, 10).items.map((item) => item.operationId)).toEqual(['1']);
    expect(repo.listPage({ sessionId: 'reject' }, null, 10).items).toEqual([]);
    expect(db.prepare('SELECT DISTINCT operation_id FROM meta_operation_sessions').all())
      .toEqual([{ operation_id: '1' }]);
  });

  it('pages only unfinished operations and never updates completed/deleted operations back into existence', () => {
    repo.create(operation('1', { state: 'pending' })); repo.create(operation('2'));
    repo.create(operation('3', { state: 'completed', resultText: 'done' }));
    expect(repo.listUnfinishedPage(null, 1)).toMatchObject({ items: [{ operationId: '1' }], nextCursor: '1' });
    expect(repo.listUnfinishedPage('1', 1)).toMatchObject({ items: [{ operationId: '2' }], nextCursor: null });
    expect(repo.update(operation('1', { state: 'interrupted' }))).toBe(true);
    expect(repo.update(operation('3'))).toBe(false);
    repo.deleteByFeature('f');
    expect(repo.update(operation('1'))).toBe(false);
    expect(repo.complete(operation('1', { state: 'completed', resultText: 'must not resurrect' }), null)).toBe(false);
    expect(repo.listUnfinishedPage(null, 1)).toEqual({ items: [], nextCursor: null });
  });

  it('atomically commits result and warm usage in the same database, rolling back both when usage fails', () => {
    const initial = operation('1'); repo.create(initial);
    const usage = {
      sessionId: 'last', featureId: 'f', providerId: 'copilot', requestedModel: 'auto',
      resolvedModel: null, transport: 'warm-acp' as const, providerSessionId: 'provider',
      purpose: null, label: null, inputTokens: 1, outputTokens: 2, nanoAiu: null, credits: null, capturedAt: 't',
    };
    const done = { ...initial, state: 'completed' as const, resultText: 'full result', sessionIds: ['new-attempt'] };
    db.exec(`CREATE TRIGGER usage.reject_meta_usage BEFORE INSERT ON meta_usage_records BEGIN SELECT RAISE(FAIL,'injected'); END`);
    expect(() => repo.complete(done, usage)).toThrow('injected');
    expect(repo.get('1')).toEqual(initial);
    expect(repo.listPage({ sessionId: 'first' }, null, 10).items).toHaveLength(1);
    expect(repo.listPage({ sessionId: 'new-attempt' }, null, 10).items).toEqual([]);
    expect(createMetaUsageRepo(db).get('last')).toBeNull();
    db.exec('DROP TRIGGER usage.reject_meta_usage');
    expect(repo.complete(done, usage)).toBe(true);
    expect(repo.get('1')?.resultText).toBe('full result');
    expect(repo.listPage({ sessionId: 'first' }, null, 10).items).toEqual([]);
    expect(repo.listPage({ sessionId: 'new-attempt' }, null, 10).items).toHaveLength(1);
    expect(createMetaUsageRepo(db).get('last')).toEqual(usage);
  });

  it.each(['origin', 'first', 'last'])('purges session attribution %s without confusing provider IDs', (sessionId) => {
    repo.create(operation('1')); repo.create(operation('2', { originSessionId: null, sessionId: 'unrelated', sessionIds: [] }));
    repo.deleteBySession(sessionId);
    expect(repo.get('1')).toBeNull(); expect(repo.get('2')).not.toBeNull();
    repo.deleteByAutomation('a');
    expect(repo.get('2')).toBeNull();
    expect(db.prepare('SELECT * FROM meta_operation_sessions').all()).toEqual([]);
  });

  it('cascades scoped deletion atomically and retains unrelated operation identities', () => {
    repo.create(operation('1'));
    repo.create(operation('2', { featureId: 'other', automationId: 'other', sessionId: 'other',
      originSessionId: null, sessionIds: [] }));
    db.exec(`CREATE TRIGGER usage.reject_identity_delete BEFORE DELETE ON meta_operation_sessions
      BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END`);
    expect(() => repo.deleteByFeature('f')).toThrow('cleanup failed');
    expect(repo.get('1')).not.toBeNull();
    expect(repo.listPage({ sessionId: 'first' }, null, 10).items).toHaveLength(1);
    db.exec('DROP TRIGGER usage.reject_identity_delete');
    repo.deleteBySession('provider');
    expect(repo.get('1')).not.toBeNull();
    repo.deleteByFeature('f');
    expect(repo.get('1')).toBeNull();
    expect(db.prepare('SELECT * FROM meta_operation_sessions').all())
      .toEqual([{ session_id: 'other', operation_id: '2' }]);
  });

  it('rejects metadata-only completion and rollbackable outer transactions', () => {
    repo.create(operation('1'));
    expect(() => repo.complete(operation('1'), null)).toThrow('full result');
    expect(() => repo.complete(operation('1', { state: 'completed' }), null)).toThrow('full result');
    db.exec('BEGIN');
    expect(() => repo.create(operation('2'))).toThrow('independent durable commit');
    expect(() => repo.update(operation('1'))).toThrow('independent durable commit');
    expect(() => repo.complete(operation('1', { state: 'completed', resultText: 'text' }), null)).toThrow('independent durable commit');
    db.exec('ROLLBACK');
    expect(repo.get('1')?.state).toBe('running');
  });

  it.each([0, -1, 1.5, 1001])('rejects invalid bounded page sizes %s', (limit) => {
    expect(() => repo.listPage({}, null, limit)).toThrow(RangeError);
    expect(() => repo.listUnfinishedPage(null, limit)).toThrow(RangeError);
  });
});
