import type { DatabaseSync } from 'node:sqlite';
import type { CapacityPoint, CapacityHistoryStore } from '../meta/capacity-history.js';
import { z } from 'zod';

const count = z.number().finite().nonnegative().nullable();
const schema = z.array(z.object({ at: z.number().finite(), provider: z.string().max(500), model: z.string().max(500).nullable(),
  busy: count, idle: count, warming: count, processes: count, queued: count })).max(600);

export function createCapacityHistoryStore(db: DatabaseSync): CapacityHistoryStore {
  return {
    load() {
      const row = db.prepare('SELECT snapshot FROM meta_capacity_history WHERE id = 1').get() as { snapshot: string } | undefined;
      return row ? schema.parse(JSON.parse(row.snapshot)) as CapacityPoint[] : [];
    },
    save(points) {
      db.prepare('INSERT INTO meta_capacity_history (id, snapshot) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot')
        .run(JSON.stringify(points));
    },
  };
}
