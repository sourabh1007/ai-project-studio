import type { ProviderRegistry } from '../provider/provider-registry.js';
import { isProviderExposed } from '../provider/default-provider-selection.js';
import type { Route } from './http-contract.js';

export interface ProviderControllerDeps {
  registry: ProviderRegistry;
  /** Reports the default provider and each provider's install state. */
  bootstrapInfo: () => ProviderBootstrapInfo;
  /**
   * Whether the user is signed in with a Microsoft identity (Azure DevOps).
   * Microsoft-only providers (Agency) are hidden entirely when false, so the
   * IDE leaves no trace of them for non-Microsoft users.
   */
  microsoftSignedIn: () => boolean;
}

/** Install state + default selection, so the first-run UI knows what to set up. */
export interface ProviderBootstrapInfo {
  /** Provider id chosen as the default for new sessions (network-based). */
  defaultProvider: string;
  /** Each registered provider with whether its CLI is installed. */
  providers: Array<{ id: string; installed: boolean }>;
  /** True when signed in with a Microsoft identity (Agency unlocked). */
  microsoftSignedIn?: boolean;
}

/** Routes exposing available providers and each provider's model catalog. */
export function createProviderRoutes(deps: ProviderControllerDeps): Route[] {
  const exposed = (id: string): boolean =>
    isProviderExposed(id, deps.microsoftSignedIn());
  return [
    {
      method: 'get',
      path: '/providers',
      handler: () => {
        const installState = new Map(
          deps.bootstrapInfo().providers.map((p) => [p.id, p.installed]),
        );
        return {
          status: 200,
          body: deps.registry
            .list()
            .filter((provider) => exposed(provider.id))
            .map((provider) => ({
              id: provider.id,
              installed: installState.get(provider.id) ?? false,
            })),
        };
      },
    },
    {
      method: 'get',
      path: '/providers/bootstrap',
      handler: () => {
        const signedIn = deps.microsoftSignedIn();
        const info = deps.bootstrapInfo();
        const providers = info.providers.filter((p) => exposed(p.id));
        const defaultProvider = providers.some((p) => p.id === info.defaultProvider)
          ? info.defaultProvider
          : providers[0]?.id ?? info.defaultProvider;
        return {
          status: 200,
          body: { defaultProvider, providers, microsoftSignedIn: signedIn },
        };
      },
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
