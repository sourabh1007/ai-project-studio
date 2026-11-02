import { describe, expect, it, vi } from 'vitest';
import { createMetaUsageCapture } from './meta-usage-capture.js';
import type { MetaOperation } from './meta-operation-contract.js';
import type { UsageCaptureRead } from '../usage/usage-capture-contract.js';
import { createDatabase } from '../persistence/db/connection.js';
import { createMetaOperationRepo } from '../persistence/meta-operation-repo.js';
import { createMetaUsageRepo } from '../persistence/meta-usage-repo.js';

const operation = (overrides: Partial<MetaOperation> = {}): MetaOperation => ({
  operationId: 'op', featureId: 'feature', automationId: null, originSessionId: null,
  providerId: 'copilot', requestedModel: 'auto', resolvedModel: null,
  sessionId: 'app', providerSessionId: 'vendor', sessionIds: ['app'],
  transport: 'warm-acp', state: 'running', outcome: 'unknown',
  purpose: null, label: 'Review board · security', resultText: null, errorMessage: null,
  usageState: 'unknown', usage: null, createdAt: 't', updatedAt: 't', startedAt: 't', finishedAt: null,
  ...overrides,
});
function page(nanoAiu: number | null, nextCursor: string | null = null): UsageCaptureRead {
  return {
    status: 'ready', sourceId: 'vendor', final: false, nextCursor,
    rows: nanoAiu === null ? [] : [{
      sourceKey: '1', event: {
        sessionId: 'vendor', featureId: 'feature', turnIndex: 0, provider: 'copilot',
        requestedModel: 'auto', resolvedModel: 'auto', operation: 'chat',
        inputTokens: 10, outputTokens: 2, reasoningOutputTokens: 0,
        nanoAiu, cost: nanoAiu / 1e9, serviceRequestId: null, startedAt: 't', endedAt: 't',
      },
    }],
  };
}
function setup(ops = [operation()]) {
  const db = createDatabase({ databasePath: ':memory:' });
  const operations = createMetaOperationRepo(db);
  ops.forEach((op) => operations.create(op));
  const read = vi.fn((): UsageCaptureRead => page(2e9));
  const onChanged = vi.fn();
  const deps = { operations, read, onChanged, now: () => 'captured', pageSize: 2, maxPages: 1 };
  return { db, operations, read, onChanged, deps, capture: createMetaUsageCapture(deps) };
}
describe('meta usage capture', () => {
  it('captures a newly finished cold operation ahead of 2000 historical rows without starving repair', () => {
    const f = setup(Array.from({ length: 2000 }, (_, i) => operation({
      operationId: `history-${String(i).padStart(4, '0')}`,
    })));
    const fresh = operation({
      operationId: 'z-new', transport: 'session', state: 'completed', resultText: 'done',
      sessionIds: ['cold-session'], sessionId: 'cold-session',
    });
    f.operations.create(fresh);
    f.capture.prioritize('z-new');
    f.capture.tick();
    expect(f.operations.get('z-new')?.usage?.credits).toBe(2);
    expect(f.read).toHaveBeenCalledTimes(1);
    f.capture.prioritize('z-new');
    f.capture.tick();
    expect(f.operations.get('history-0000')?.usage?.credits).toBe(2);
    f.capture.tick();
    expect(f.onChanged).toHaveBeenCalledTimes(2);
    f.db.close();
  });

  it('bounds lifecycle hints, deduplicates, skips deleted hints, and interleaves multipage priority reads', () => {
    const f = setup([operation({ operationId: 'a-history' }), operation({
      operationId: 'z-priority', transport: 'session', sessionIds: ['first', 'second'], sessionId: 'second',
    })]);
    for (let i = 0; i < 300; i++) f.capture.prioritize(`deleted-${i}`);
    f.capture.prioritize('z-priority');
    f.capture.prioritize('z-priority');
    const get = vi.spyOn(f.operations, 'getSummary');
    for (let i = 0; i < 520; i++) f.capture.tick();
    expect(get).toHaveBeenCalledTimes(256);
    expect(f.operations.get('z-priority')?.usage?.credits).toBe(4);
    f.read.mockReturnValueOnce(page(1e9, 'more')).mockReturnValueOnce(page(5e9))
      .mockReturnValueOnce(page(2e9)).mockReturnValue(page(3e9));
    f.capture.prioritize('z-priority');
    for (let i = 0; i < 8; i++) f.capture.tick();
    expect(f.operations.get('z-priority')?.usage).not.toBeNull();
    f.db.close();
  });

  it('allows failed priority capture and operations without identities to yield back to history', () => {
    const f = setup([operation({ operationId: 'a' }), operation({ operationId: 'empty', providerSessionId: null })]);
    f.capture.prioritize('a');
    f.read.mockReturnValueOnce({ status: 'retrying', sourceId: 'vendor', reason: 'locked' });
    f.capture.tick();
    f.capture.prioritize('empty');
    for (let i = 0; i < 5; i++) f.capture.tick();
    expect(f.operations.get('a')?.usage?.credits).toBe(2);
    f.capture.prioritize('a');
    f.read.mockReturnValueOnce(page(null));
    for (let i = 0; i < 4; i++) f.capture.tick();
    f.db.close();
  });

  it('retries late cold usage promptly but bounds empty-source retries and admits newer lifecycle hints first', () => {
    const f = setup([operation({ operationId: 'old' }), operation({ operationId: 'z-new', transport: 'session' })]);
    f.capture.prioritize('old');
    f.capture.prioritize('z-new');
    f.read.mockReturnValueOnce(page(null));
    f.capture.tick();
    expect(f.read).toHaveBeenLastCalledWith('app', expect.objectContaining({ operationId: 'z-new' }), null, 2);
    f.capture.tick();
    f.read.mockReturnValueOnce(page(5e9));
    f.capture.tick();
    expect(f.operations.get('z-new')?.usage?.credits).toBe(5);
    f.read.mockReturnValue(page(null));
    f.capture.prioritize('z-new');
    const get = vi.spyOn(f.operations, 'getSummary');
    for (let i = 0; i < 20; i++) f.capture.tick();
    expect(get).toHaveBeenCalledTimes(8); // Four bounded attempts for each queued operation.
    f.db.close();
  });
  it('retains missing native charges while summing known tokens across mixed observations', () => {
    const f = setup();
    const known = page(1e9);
    if (known.status !== 'ready') throw new Error('expected ready');
    const event = known.rows[0].event;
    f.read.mockReturnValue({ ...known, rows: [
      { sourceKey: 'a', event },
      { sourceKey: 'b', event: { ...event, provider: 'claude', cost: null, nanoAiu: null } },
      { sourceKey: 'c', event },
    ] });
    f.capture.tick();
    expect(f.operations.get('op')?.usage).toEqual({ inputTokens: 30, outputTokens: 6, nanoAiu: null, credits: null });
    f.db.close();
  });
  it('captures warm vendor usage while running, persists it for summary, and replaces corrections', () => {
    const f = setup();
    f.capture.tick();
    expect(f.read).toHaveBeenCalledWith('vendor', expect.objectContaining({ featureId: 'feature' }), null, 2);
    expect(f.operations.get('op')?.usage).toEqual({ inputTokens: 10, outputTokens: 2, nanoAiu: 2e9, credits: 2 });
    expect(createMetaUsageRepo(f.db).get('app')?.credits).toBe(2);
    expect(createMetaUsageRepo(f.db).get('app')?.capturedAt).toBe('t');
    f.capture.tick();
    expect(f.onChanged).toHaveBeenCalledTimes(1);
    f.read.mockReturnValue(page(1e9));
    f.capture.tick();
    expect(f.operations.get('op')?.usage?.credits).toBe(1);
    expect(createMetaUsageRepo(f.db).get('app')?.capturedAt).toBe('t');
    expect(f.onChanged).toHaveBeenCalledTimes(2);
    f.db.close();
  });

  it('completion and subsequent start updates do not erase a captured charge', () => {
    const f = setup();
    f.capture.tick();
    expect(f.operations.update(operation())).toBe(true);
    f.operations.complete(operation({ state: 'completed', resultText: 'done', usage: {
      inputTokens: 99, outputTokens: 4, nanoAiu: null, credits: null,
    } }), {
      sessionId: 'app', featureId: 'feature', providerId: 'copilot', requestedModel: 'auto',
      resolvedModel: null, transport: 'warm-acp', providerSessionId: 'vendor',
      purpose: null, label: 'Review board', inputTokens: 99, outputTokens: 4,
      nanoAiu: null, credits: null, capturedAt: 't',
    });
    expect(f.operations.get('op')?.usage?.credits).toBe(2);
    expect(createMetaUsageRepo(f.db).get('app')?.credits).toBe(2);
    f.db.close();
  });

  it('bounds reads across pages and counts each physical retry exactly once', () => {
    const f = setup([operation({
      transport: 'session', sessionId: 'second', sessionIds: ['first', 'first', 'second'],
      state: 'failed',
    })]);
    f.read.mockReturnValueOnce(page(1e9, 'next')).mockReturnValueOnce(page(2e9)).mockReturnValue(page(3e9));
    f.capture.tick();
    expect(f.operations.get('op')?.usage).toBeNull();
    f.capture.tick();
    expect(f.read.mock.calls[1]).toEqual(['first', expect.anything(), 'next', 2]);
    f.capture.tick();
    expect(f.operations.get('op')?.usage?.credits).toBe(6);
    expect(createMetaUsageRepo(f.db).get('second')).toBeNull();
    f.db.close();
  });

  it('never fabricates zero for empty, missing, unsupported or incomplete sources', () => {
    const f = setup();
    for (const result of [
      page(null),
      { status: 'retrying', sourceId: 'vendor', reason: 'missing' } as const,
      { status: 'unsupported', sourceId: 'vendor', reason: 'schema' } as const,
      { ...page(3e9), issue: { status: 'retrying', reason: 'incomplete' } } as UsageCaptureRead,
    ]) {
      f.read.mockReturnValue(result);
      f.capture.tick();
      expect(f.operations.get('op')?.usage).toBeNull();
    }
    f.read.mockReturnValue(page(0));
    f.capture.tick();
    expect(f.operations.get('op')?.usage?.credits).toBe(0);
    f.db.close();
  });

  it('sweeps operation pages, retries failures on the next sweep, and skips missing identities', () => {
    const f = setup([
      operation({ operationId: 'a', providerSessionId: null }),
      operation({ operationId: 'b', transport: 'unknown', sessionId: null, sessionIds: [] }),
      operation({ operationId: 'c' }),
      operation({ operationId: 'd' }),
    ]);
    const capture = createMetaUsageCapture({ ...f.deps, maxPages: 8 });
    f.read.mockReturnValueOnce({ status: 'retrying', sourceId: 'vendor', reason: 'locked' });
    capture.tick();
    expect(f.operations.get('c')?.usage).toBeNull();
    expect(f.operations.get('d')?.usage?.credits).toBe(2);
    capture.tick();
    expect(f.operations.get('c')?.usage?.credits).toBe(2);
    f.db.close();
  });

  it('does not recreate deleted rows and handles an empty ledger', () => {
    const f = setup();
    f.read.mockReturnValueOnce(page(2e9, 'more'));
    f.capture.tick();
    f.operations.deleteByFeature('feature');
    f.capture.tick();
    f.capture.tick();
    expect(f.operations.get('op')).toBeNull();
    expect(f.onChanged).not.toHaveBeenCalled();
    f.db.close();
  });

  it('continues after an empty source without attributing another operation to it', () => {
    const f = setup([operation({ operationId: 'a' }), operation({ operationId: 'b' })]);
    f.read.mockReturnValueOnce(page(null));
    createMetaUsageCapture({ ...f.deps, maxPages: 4 }).tick();
    expect(f.operations.get('a')?.usage).toBeNull();
    expect(f.operations.get('b')?.usage?.credits).toBe(2);
    f.db.close();
  });
});
