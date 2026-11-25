import { expect, it } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createResourceHistoryStore } from './resource-history-repo.js';
import { createCapacityHistoryStore } from './capacity-history-repo.js';

it('round-trips bounded resource and capacity histories independently across adapter instances', () => {
  const db = createDatabase({ databasePath: ':memory:' });
  try {
    const resources = createResourceHistoryStore(db);
    const capacity = createCapacityHistoryStore(db);
    expect(resources.load()).toBeNull();
    expect(capacity.load()).toEqual([]);
    const history = { startedAt: 1, maxGapMs: 30000, error: null, samples: [], storage: [] };
    resources.save(history); resources.save({ ...history, startedAt: 2 });
    capacity.save([]); capacity.save([{ at: 3, provider: 'p', model: null, busy: 1, idle: 0, warming: 0, processes: 1, queued: 0 }]);
    expect(createResourceHistoryStore(db).load()?.startedAt).toBe(2);
    expect(createCapacityHistoryStore(db).load()).toMatchObject([{ at: 3, busy: 1 }]);
    db.prepare('UPDATE resource_history SET snapshot = ?').run('{"samples":null}');
    db.prepare('UPDATE meta_capacity_history SET snapshot = ?').run('{}');
    expect(() => resources.load()).toThrow();
    expect(() => capacity.load()).toThrow();
  } finally { db.close(); }
});
