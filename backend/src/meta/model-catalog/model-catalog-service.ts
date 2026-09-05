import type {
  MetaModelOption,
  ModelCatalogProbe,
} from './model-catalog-contract.js';

/**
 * Serves the selectable AI model catalog (ids + names + pricing hints) fetched
 * from the Agency/Copilot CLI over ACP. Because each fetch spins up a
 * short-lived `copilot --acp` session (seconds), results are cached: a fresh
 * catalog is returned as-is, a stale one is returned immediately while a
 * refresh runs in the background, and the very first read awaits a fetch.
 * Fetches are single-flighted so overlapping reads share one probe.
 */
export interface ModelCatalogService {
  /** Returns the latest catalog, refreshing lazily when stale. */
  read(): Promise<MetaModelOption[] | null>;
  /** Forces a fetch, updating the cache; shared when already in flight. */
  refresh(): Promise<MetaModelOption[] | null>;
}

export interface ModelCatalogServiceDeps {
  probe: ModelCatalogProbe;
  /** Clock, injectable for tests. */
  now: () => number;
  /** How long a fetched catalog is considered fresh, in milliseconds. */
  ttlMs: number;
}

export function createModelCatalogService(
  deps: ModelCatalogServiceDeps,
): ModelCatalogService {
  let cached: MetaModelOption[] | null = null;
  let cachedAt = 0;
  let inFlight: Promise<MetaModelOption[] | null> | null = null;

  const runProbe = async (): Promise<MetaModelOption[] | null> => {
    const models = await deps.probe.fetch();
    // Keep any prior snapshot when the probe failed or returned nothing. With
    // no prior snapshot, negative-cache an empty list so a persistently
    // unavailable catalog is retried only once per TTL instead of on every
    // read (each probe spawns a short-lived CLI, so stampeding would hang).
    if (models === null || models.length === 0) {
      if (cached === null) {
        cached = [];
        cachedAt = deps.now();
      }
      return cached;
    }
    cached = models;
    cachedAt = deps.now();
    return models;
  };

  const refresh = (): Promise<MetaModelOption[] | null> => {
    if (inFlight) {
      return inFlight;
    }
    const run = runProbe().finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  };

  return {
    refresh,
    read() {
      if (cached === null) {
        return refresh();
      }
      // A negative-cached empty catalog (the probe hasn't succeeded yet) is
      // always revalidated in the background so a slow first ACP spawn fills in
      // shortly; single-flighting keeps this from stampeding the CLI. A real,
      // non-empty catalog is only refreshed once it goes stale.
      const fresh = cached.length > 0 && deps.now() - cachedAt < deps.ttlMs;
      if (!fresh) {
        void refresh();
      }
      return Promise.resolve(cached);
    },
  };
}
