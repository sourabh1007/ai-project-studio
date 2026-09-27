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
