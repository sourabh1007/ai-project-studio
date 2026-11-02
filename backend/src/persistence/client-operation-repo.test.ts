import { describe, expect, it } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createClientOperationRepo } from './client-operation-repo.js';

describe('client operation repo', () => {
  const repo = () => createClientOperationRepo(createDatabase({ databasePath: ':memory:' }));

  it('reserves once, completes once, and reads back', () => {
    const r = repo();
    expect(r.get('s', 'k')).toBeUndefined();
    expect(r.reservePending('s', 'k', 'h', 10)).toBe(true);
    expect(r.reservePending('s', 'k', 'other', 11)).toBe(false);
    expect(r.get('s', 'k')).toEqual({ scope: 's', key: 'k', requestHash: 'h', state: 'pending', status: null, responseJson: null });
    expect(r.complete('s', 'k', 201, '{"id":1}', 12)).toBe(true);
    expect(r.complete('s', 'k', 500, 'x', 13)).toBe(false);
    expect(r.get('s', 'k')).toMatchObject({ state: 'succeeded', status: 201, responseJson: '{"id":1}' });
  });

  it('releases only pending records', () => {
    const r = repo();
    r.reservePending('s', 'p', 'h', 1);
    r.reservePending('s', 'd', 'h', 1);
    r.complete('s', 'd', 200, '{}', 2);
    r.releasePending('s', 'p', 'other');
    expect(r.get('s', 'p')?.state).toBe('pending');
    r.releasePending('s', 'p', 'h');
    r.releasePending('s', 'd', 'h');
    expect(r.get('s', 'p')).toBeUndefined();
    expect(r.get('s', 'd')?.state).toBe('succeeded');
  });

  it('counts and prunes only old succeeded records up to the limit', () => {
    const r = repo();
    for (const key of ['a', 'b', 'c']) { r.reservePending('s', key, 'h', 1); r.complete('s', key, 200, '{}', 5); }
    r.reservePending('s', 'pending', 'h', 1);
    expect(r.count()).toBe(4);
    expect(r.pruneSucceeded(5, 10)).toBe(0);
    expect(r.pruneSucceeded(6, 2)).toBe(2);
    expect(r.pruneSucceeded(6, 10)).toBe(1);
    expect(r.count()).toBe(1);
    expect(r.get('s', 'pending')?.state).toBe('pending');
  });
});
