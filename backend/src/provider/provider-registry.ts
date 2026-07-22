import { NotFoundError, ConflictError } from '../kernel/error-types.js';
import type { IAIProvider } from './provider-contract.js';

/** Registry of available AI providers, keyed by provider id. */
export interface ProviderRegistry {
  register(provider: IAIProvider): void;
  get(id: string): IAIProvider;
  has(id: string): boolean;
  list(): IAIProvider[];
  ids(): string[];
}

export function createProviderRegistry(): ProviderRegistry {
  const providers = new Map<string, IAIProvider>();

  return {
    register(provider) {
      if (providers.has(provider.id)) {
        throw new ConflictError(`Provider already registered: ${provider.id}`);
      }
      providers.set(provider.id, provider);
    },
    get(id) {
      const provider = providers.get(id);
      if (!provider) {
        throw new NotFoundError(`Unknown provider: ${id}`);
      }
      return provider;
    },
    has(id) {
      return providers.has(id);
    },
    list() {
      return [...providers.values()];
    },
    ids() {
      return [...providers.keys()];
    },
  };
}
