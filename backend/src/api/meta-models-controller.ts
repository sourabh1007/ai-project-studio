import type { ModelCatalogService } from '../meta/model-catalog/model-catalog-service.js';
import type { Route } from './http-contract.js';

export interface MetaModelsControllerDeps {
  metaModels: ModelCatalogService;
}

/**
 * Route exposing the selectable AI model catalog (ids, names and the CLI's
 * pricing hints) the IDE offers for its metasessions. Sourced from the
 * Agency/Copilot CLI over ACP and cached. Returns `200` with an empty array
 * when the catalog could not be fetched yet so the Settings picker can fall
 * back to the currently-configured model gracefully.
 */
export function createMetaModelsRoutes(deps: MetaModelsControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/meta/models',
      handler: async () => ({
        status: 200,
        body: (await deps.metaModels.read()) ?? [],
      }),
    },
  ];
}
