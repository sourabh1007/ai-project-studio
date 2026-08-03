import type { DatabaseSync } from 'node:sqlite';
import type { ConfigObject } from '../config/config-contract.js';
import type {
  ConfigOverrideRecord,
  ConfigOverrideStore,
} from '../config/config-override-store.js';

interface ConfigOverrideRow {
  namespace: string;
  data: string;
  updated_at: string;
}

function toRecord(row: ConfigOverrideRow): ConfigOverrideRecord {
  return {
    namespace: row.namespace,
    data: JSON.parse(row.data) as ConfigObject,
    updatedAt: row.updated_at,
  };
}

/** SQLite-backed implementation of the ConfigOverrideStore port. */
export function createConfigOverrideRepo(db: DatabaseSync): ConfigOverrideStore {
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO config_overrides (namespace, data, updated_at)
     VALUES (?, ?, ?)`,
  );
  const selectAll = db.prepare(
    'SELECT * FROM config_overrides ORDER BY namespace',
  );
  const selectOne = db.prepare(
    'SELECT * FROM config_overrides WHERE namespace = ?',
  );
  const deleteOne = db.prepare(
    'DELETE FROM config_overrides WHERE namespace = ?',
  );

  return {
    all() {
      return (selectAll.all() as unknown as ConfigOverrideRow[]).map(toRecord);
    },
    get(namespace: string) {
      const row = selectOne.get(namespace) as unknown as
        | ConfigOverrideRow
        | undefined;
      return row ? toRecord(row) : null;
    },
    set(record: ConfigOverrideRecord) {
      upsert.run(
        record.namespace,
        JSON.stringify(record.data),
        record.updatedAt,
      );
    },
    delete(namespace: string) {
      deleteOne.run(namespace);
    },
  };
}
