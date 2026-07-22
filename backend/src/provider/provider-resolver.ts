import { ValidationError } from '../kernel/error-types.js';
import type { ProviderRegistry } from './provider-registry.js';
import type { IAIProvider } from './provider-contract.js';

export interface ResolveRequest {
  providerId?: string;
  model?: string;
}

export interface ResolvedSelection {
  provider: IAIProvider;
  model: string;
}

export interface ResolverConfig {
  defaultProvider: string;
  /** Per-provider default model; falls back to 'auto' when absent. */
  defaultModelByProvider: Record<string, string>;
}

/**
 * Resolves a (provider, model) selection from a partial request, applying
 * configured defaults and validating the model against the provider's catalog.
 * `auto` bypasses catalog validation (the provider chooses).
 */
export interface ProviderResolver {
  resolve(request: ResolveRequest): Promise<ResolvedSelection>;
}

export function createProviderResolver(
  registry: ProviderRegistry,
  config: ResolverConfig,
): ProviderResolver {
  return {
    async resolve(request) {
      const providerId = request.providerId ?? config.defaultProvider;
      const provider = registry.get(providerId);
      const model =
        request.model ??
        config.defaultModelByProvider[providerId] ??
        'auto';

      if (model !== 'auto') {
        const models = await provider.listModels();
        if (!models.some((m) => m.id === model)) {
          throw new ValidationError(
            `Model '${model}' is not available for provider '${providerId}'`,
          );
        }
      }

      return { provider, model };
    },
  };
}
