import type { ProviderRegistry } from '../provider/provider-registry.js';
import type { Route } from './http-contract.js';

export interface ProviderControllerDeps {
  registry: ProviderRegistry;
}

/** Routes exposing available providers and each provider's model catalog. */
export function createProviderRoutes(deps: ProviderControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/providers',
      handler: () => ({
        status: 200,
        body: deps.registry.list().map((provider) => ({ id: provider.id })),
      }),
    },
    {
      method: 'get',
      path: '/providers/:id/models',
      handler: async (req) => ({
        status: 200,
        body: await deps.registry.get(req.params.id).listModels(),
      }),
    },
  ];
}
