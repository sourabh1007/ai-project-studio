import { describe, expect, it } from 'vitest';
import { createConfigOverrideRepo } from './config-override-repo.js';
import { createDatabase } from './db/connection.js';

describe('config-override-repo', () => {
  it('returns null and an empty list when nothing is stored', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createConfigOverrideRepo(db);
    expect(repo.get('demo')).toBeNull();
    expect(repo.all()).toEqual([]);
    db.close();
  });

  it('upserts, reads back and lists overrides sorted by namespace', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createConfigOverrideRepo(db);
    repo.set({
      namespace: 'beta',
      data: { s: 'x' },
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    repo.set({
      namespace: 'alpha',
      data: { n: 1 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(repo.get('alpha')).toEqual({
      namespace: 'alpha',
      data: { n: 1 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(repo.all().map((r) => r.namespace)).toEqual(['alpha', 'beta']);
    db.close();
  });

  it('replaces an existing override on re-set', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createConfigOverrideRepo(db);
    repo.set({ namespace: 'demo', data: { n: 1 }, updatedAt: 'a' });
    repo.set({ namespace: 'demo', data: { n: 2 }, updatedAt: 'b' });
    expect(repo.all()).toHaveLength(1);
    expect(repo.get('demo')?.data).toEqual({ n: 2 });
    db.close();
  });

  it('deletes an override', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createConfigOverrideRepo(db);
    repo.set({ namespace: 'demo', data: { n: 1 }, updatedAt: 'a' });
    repo.delete('demo');
    expect(repo.get('demo')).toBeNull();
    db.close();
  });
});
