import type { ConfigObject } from './config-contract.js';

/** One persisted per-namespace override patch. */
export interface ConfigOverrideRecord {
  readonly namespace: string;
  /** Partial config patch, deep-merged over the namespace defaults. */
  readonly data: ConfigObject;
  readonly updatedAt: string;
}

/**
 * Persistence port for user-editable configuration overrides. Overrides are
 * stored as partial patches per namespace so that unchanged keys keep tracking
 * their compiled defaults across upgrades.
 */
export interface ConfigOverrideStore {
  /** All persisted overrides, most useful as a `{ namespace: patch }` map. */
  all(): ConfigOverrideRecord[];
  /** The override patch for one namespace, or null when none is stored. */
  get(namespace: string): ConfigOverrideRecord | null;
  /** Upsert the override patch for one namespace. */
  set(record: ConfigOverrideRecord): void;
  /** Remove any override patch for one namespace (reset to defaults). */
  delete(namespace: string): void;
}

/** Collapses override records into a single `{ namespace: patch }` object. */
export function overridesToConfig(
  records: readonly ConfigOverrideRecord[],
): ConfigObject {
  const out: ConfigObject = {};
  for (const record of records) {
    out[record.namespace] = record.data;
  }
  return out;
}
