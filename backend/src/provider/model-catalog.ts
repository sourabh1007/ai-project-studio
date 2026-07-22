import type { Clock } from '../kernel/clock.js';
import type { ModelInfo } from './provider-contract.js';
import type { ProviderRegistry } from './provider-registry.js';

interface CacheEntry {
  at: number;
  value: ModelInfo[];
}

export interface ModelCatalogConfig {
  ttlMs: number;
}

/**
 * Caches each provider's model list for a configurable TTL so the UI can list
 * models without re-invoking the CLI on every request.
 */
export interface ModelCatalog {
  models(providerId: string): Promise<ModelInfo[]>;
  all(): Promise<Record<string, ModelInfo[]>>;
  invalidate(providerId?: string): void;
}

export function createModelCatalog(
  registry: ProviderRegistry,
  config: ModelCatalogConfig,
  clock: Clock,
): ModelCatalog {
  const cache = new Map<string, CacheEntry>();

  const models = async (providerId: string): Promise<ModelInfo[]> => {
    const now = clock.now().getTime();
    const cached = cache.get(providerId);
    if (cached && now - cached.at < config.ttlMs) {
      return cached.value;
    }
    const provider = registry.get(providerId);
    const value = await provider.listModels();
    cache.set(providerId, { at: now, value });
    return value;
  };

  return {
    models,
    async all() {
      const out: Record<string, ModelInfo[]> = {};
      for (const id of registry.ids()) {
        out[id] = await models(id);
      }
      return out;
    },
    invalidate(providerId) {
      if (providerId === undefined) {
        cache.clear();
        return;
      }
      cache.delete(providerId);
    },
  };
}
