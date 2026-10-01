import type { ProviderRegistry } from '../provider/provider-registry.js';
import type { Route } from './http-contract.js';

export interface ProviderControllerDeps {
  registry: ProviderRegistry;
  /** Reports the default provider and each provider's install state. */
  bootstrapInfo: () => ProviderBootstrapInfo;
}

/** Install state + default selection, so the first-run UI knows what to set up. */
export interface ProviderBootstrapInfo {
  /** Provider id chosen as the default for new sessions (network-based). */
  defaultProvider: string;
  /** Each registered provider with whether its CLI is installed. */
  providers: Array<{ id: string; installed: boolean }>;
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
      path: '/providers/bootstrap',
      handler: () => ({ status: 200, body: deps.bootstrapInfo() }),
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
