import type { DatabaseSync } from 'node:sqlite';
import type { ResourceHistory, ResourceHistoryStore } from '../resources/resources-contract.js';
import { z } from 'zod';

const value = z.number().finite().nonnegative().nullable();
const schema = z.object({
  startedAt: z.number().finite(), maxGapMs: z.number().finite().positive(), error: z.string().nullable(),
  samples: z.array(z.object({ at: z.number().finite(), hostCpu: value, freeMemory: value,
    appCpu: value, appMemory: value, eventLoopDelay: value })).max(600),
  storage: z.array(z.object({ at: z.number().finite(), category: z.string().max(100),
    scope: z.string().max(65536), bytes: value })).max(450),
});

export function createResourceHistoryStore(db: DatabaseSync): ResourceHistoryStore {
  return {
    load() {
      const row = db.prepare('SELECT snapshot FROM resource_history WHERE id = 1').get() as { snapshot: string } | undefined;
      return row ? schema.parse(JSON.parse(row.snapshot)) as ResourceHistory : null;
    },
    save(history) {
      db.prepare('INSERT INTO resource_history (id, snapshot) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot')
        .run(JSON.stringify(history));
    },
  };
}
