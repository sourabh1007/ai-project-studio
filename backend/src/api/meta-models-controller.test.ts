import { describe, it, expect } from 'vitest';
import { createMetaModelsRoutes } from './meta-models-controller.js';
import type { ModelCatalogService } from '../meta/model-catalog/model-catalog-service.js';
import type { MetaModelOption } from '../meta/model-catalog/model-catalog-contract.js';
import type { HttpRequest, Route } from './http-contract.js';

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`route ${method} ${path} not found`);
  }
  return route.handler;
}

const req = (): HttpRequest => ({ params: {}, query: {}, body: undefined });

const catalog: MetaModelOption[] = [
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    description: 'GPT-5.4',
    usageLabel: '1x',
    usageMultiplier: 1,
    priceCategory: 'medium',
    enabled: true,
  },
];

describe('meta-models-controller', () => {
  it('serves the model catalog', async () => {
    const metaModels = {
      read: async () => catalog,
    } as unknown as ModelCatalogService;
    const res = await pick(
      createMetaModelsRoutes({ metaModels }),
      'get',
      '/meta/models',
    )(req());
    expect(res).toEqual({ status: 200, body: catalog });
  });

  it('returns an empty array when the catalog is unavailable', async () => {
    const metaModels = {
      read: async () => null,
    } as unknown as ModelCatalogService;
    const res = await pick(
      createMetaModelsRoutes({ metaModels }),
      'get',
      '/meta/models',
    )(req());
    expect(res).toEqual({ status: 200, body: [] });
  });
});
