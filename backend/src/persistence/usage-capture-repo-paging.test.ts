import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatementSync, type DatabaseSync } from 'node:sqlite';
import { createDatabase } from './db/connection.js';
import { createUsageCaptureRepo } from './usage-capture-repo.js';
import type { UsageCaptureRepo, UsageCaptureStatus } from '../usage/usage-capture-contract.js';

describe('bounded unfinished capture pages', () => {
  let db: DatabaseSync;
  let captures: UsageCaptureRepo;
  beforeEach(() => {
    db = createDatabase({ databasePath: ':memory:' });
    captures = createUsageCaptureRepo(db);
  });
  afterEach(() => db.close());
  const seed = (sessionId: string, status: UsageCaptureStatus = 'pending') => captures.save({
    sessionId, sourceId: 'source', cursor: 'source-position', replayCursor: 7,
    status, reason: status === 'complete' ? null : 'source-finality-unknown',
  });

  it('returns empty pages and excludes completed captures', () => {
    expect(captures.listUnfinishedPage(null, 2)).toEqual({ items: [], nextCursor: null });
    seed('a', 'complete');
    expect(captures.listUnfinishedPage(null, 2)).toEqual({ items: [], nextCursor: null });
    expect(captures.listUnfinishedPage('z', 2)).toEqual({ items: [], nextCursor: null });
  });

  it('uses ordered keyset boundaries and only returns a cursor when another row exists', () => {
    seed('d', 'unsupported'); seed('b', 'retrying'); seed('c'); seed('a');
    const first = captures.listUnfinishedPage(null, 2);
    expect(first.items.map((state) => state.sessionId)).toEqual(['a', 'b']);
    expect(first.nextCursor).toBe('b');
    expect(first.items[1]).toMatchObject({ status: 'retrying', cursor: 'source-position', replayCursor: 7 });
    const second = captures.listUnfinishedPage(first.nextCursor, 2);
    expect(second.items.map((state) => state.sessionId)).toEqual(['c', 'd']);
    expect(second.nextCursor).toBeNull();
    expect(second.items[1].status).toBe('unsupported');
    expect(captures.listUnfinishedPage(null, 2)).toEqual(first);
  });

  it('handles deletion of the cursor and later entries, status changes, and insertions behind a cursor fairly on wrap', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) seed(id);
    const first = captures.listUnfinishedPage(null, 2);
    captures.deleteBySession('b');
    captures.deleteBySession('d');
    seed('c', 'complete');
    seed('aa');
    const second = captures.listUnfinishedPage(first.nextCursor, 2);
    expect(second.items.map((state) => state.sessionId)).toEqual(['e']);
    expect(second.nextCursor).toBeNull();
    const wrapped = captures.listUnfinishedPage(second.nextCursor, 2);
    expect(wrapped.items.map((state) => state.sessionId)).toEqual(['a', 'aa']);
    expect(wrapped.nextCursor).toBe('aa');
    seed('c', 'retrying');
    expect(captures.listUnfinishedPage(wrapped.nextCursor, 2).items.map((state) => state.sessionId)).toEqual(['c', 'e']);
  });

  it('materializes only the requested page plus one native SQLite lookahead row, not all capture history', () => {
    for (let index = 0; index < 2500; index++) seed(index.toString().padStart(4, '0'));
    const all = vi.spyOn(StatementSync.prototype, 'all');
    try {
      const first = captures.listUnfinishedPage(null, 2);
      expect(first.items.map((state) => state.sessionId)).toEqual(['0000', '0001']);
      expect(first.nextCursor).toBe('0001');
      expect(all).toHaveBeenCalledTimes(1);
      expect(all).toHaveBeenLastCalledWith(3);
      expect(all.mock.results[0].value).toHaveLength(3);
      const second = captures.listUnfinishedPage(first.nextCursor, 2);
      expect(second.items.map((state) => state.sessionId)).toEqual(['0002', '0003']);
      expect(all).toHaveBeenCalledTimes(2);
      expect(all).toHaveBeenLastCalledWith('0001', 3);
      expect(all.mock.results[1].value).toHaveLength(3);
    } finally { all.mockRestore(); }
  });

  it.each([0, -1, 1.5, 1001, NaN, Infinity])('rejects invalid page limits (%s)', (limit) => {
    expect(() => captures.listUnfinishedPage(null, limit)).toThrow(RangeError);
  });
});
