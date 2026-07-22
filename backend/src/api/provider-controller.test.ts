import { describe, it, expect } from 'vitest';
import { createProviderRoutes } from './provider-controller.js';
import { createProviderRegistry } from '../provider/provider-registry.js';
import type { IAIProvider, ModelInfo } from '../provider/provider-contract.js';
import type { HttpRequest, Route } from './http-contract.js';

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`route ${method} ${path} not found`);
  }
  return route.handler;
}

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...overrides };
}

function provider(id: string, models: ModelInfo[]): IAIProvider {
  return {
    id,
    listModels: async () => models,
    startSession: () => {
      throw new Error('not used');
    },
    buildInteractiveCommand: () => {
      throw new Error('not used');
    },
  };
}

function harness() {
  const registry = createProviderRegistry();
  registry.register(provider('copilot', [{ id: 'gpt-5.4-mini', label: 'GPT' }]));
  registry.register(provider('agency', []));
  return createProviderRoutes({ registry });
}

describe('provider-controller', () => {
  it('lists provider ids', async () => {
    const result = await pick(harness(), 'get', '/providers')(req());
    expect(result.status).toBe(200);
    expect(result.body).toEqual([{ id: 'copilot' }, { id: 'agency' }]);
  });

  it('lists models for a provider', async () => {
    const result = await pick(harness(), 'get', '/providers/:id/models')(
      req({ params: { id: 'copilot' } }),
    );
    expect(result.body).toEqual([{ id: 'gpt-5.4-mini', label: 'GPT' }]);
  });

  it('throws not-found for an unknown provider', async () => {
    await expect(
      pick(harness(), 'get', '/providers/:id/models')(
        req({ params: { id: 'nope' } }),
      ),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
});
