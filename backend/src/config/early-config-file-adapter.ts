import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigOverrideRecord, ConfigOverrideStore } from './config-override-store.js';

/** Desktop reads this same record before provisioning; no SQLite mirror exists. */
export function createEarlyConfigFileStore(namespace: string, path: string): ConfigOverrideStore {
  const read = (): ConfigOverrideRecord | null => {
    try {
      const record = JSON.parse(readFileSync(path, 'utf8')) as ConfigOverrideRecord;
      if (record.namespace !== namespace || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)) {
        throw new Error('Invalid early module override');
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Could not read ${namespace} executable settings`, { cause: error });
    }
  };
  return {
    all: () => { const record = read(); return record ? [record] : []; },
    get: () => read(),
    set: (record) => {
      mkdirSync(dirname(path), { recursive: true });
      const next = `${path}.next`;
      writeFileSync(next, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
      renameSync(next, path);
    },
    delete: () => rmSync(path, { force: true }),
  };
}
