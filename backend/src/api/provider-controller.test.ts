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

function harness(signedIn = true) {
  const registry = createProviderRegistry();
  registry.register(provider('copilot', [{ id: 'gpt-5.4-mini', label: 'GPT' }]));
  registry.register(provider('agency', []));
  return createProviderRoutes({
    registry,
    microsoftSignedIn: () => signedIn,
    bootstrapInfo: () => ({
      defaultProvider: signedIn ? 'agency' : 'copilot',
      providers: [
        { id: 'copilot', installed: true },
        { id: 'agency', installed: false },
      ],
    }),
  });
}

describe('provider-controller', () => {
  it('lists provider ids with install state', async () => {
    const result = await pick(harness(), 'get', '/providers')(req());
    expect(result.status).toBe(200);
    expect(result.body).toEqual([
      { id: 'copilot', installed: true },
      { id: 'agency', installed: false },
    ]);
  });

  it('hides Agency entirely when not signed in with a Microsoft identity', async () => {
    const list = await pick(harness(false), 'get', '/providers')(req());
    expect(list.body).toEqual([{ id: 'copilot', installed: true }]);
    const boot = await pick(harness(false), 'get', '/providers/bootstrap')(req());
    expect(boot.body).toEqual({
      defaultProvider: 'copilot',
      providers: [{ id: 'copilot', installed: true }],
      microsoftSignedIn: false,
    });
  });

  it('falls back the default to an exposed provider when bootstrap still names a hidden one', async () => {
    const registry = createProviderRegistry();
    registry.register(provider('copilot', []));
    registry.register(provider('agency', []));
    const routes = createProviderRoutes({
      registry,
      microsoftSignedIn: () => false,
      bootstrapInfo: () => ({
        defaultProvider: 'agency',
        providers: [
          { id: 'copilot', installed: true },
          { id: 'agency', installed: true },
        ],
      }),
    });
    const boot = await pick(routes, 'get', '/providers/bootstrap')(req());
    expect(boot.body).toMatchObject({ defaultProvider: 'copilot', microsoftSignedIn: false });
  });

  it('keeps an unexposed default only when no provider is exposed', async () => {
    const registry = createProviderRegistry();
    registry.register(provider('agency', []));
    const routes = createProviderRoutes({
      registry,
      microsoftSignedIn: () => false,
      bootstrapInfo: () => ({
        defaultProvider: 'agency',
        providers: [{ id: 'agency', installed: true }],
      }),
    });
    const boot = await pick(routes, 'get', '/providers/bootstrap')(req());
    expect(boot.body).toEqual({
      defaultProvider: 'agency',
      providers: [],
      microsoftSignedIn: false,
    });
  });

  it('defaults install state to false for providers missing from bootstrap', async () => {
    const registry = createProviderRegistry();
    registry.register(provider('copilot', []));
    registry.register(provider('ghost', []));
    const routes = createProviderRoutes({
      registry,
      microsoftSignedIn: () => true,
      bootstrapInfo: () => ({
        defaultProvider: 'copilot',
        providers: [{ id: 'copilot', installed: true }],
      }),
    });
    const result = await pick(routes, 'get', '/providers')(req());
    expect(result.body).toEqual([
      { id: 'copilot', installed: true },
      { id: 'ghost', installed: false },
    ]);
  });

  it('reports bootstrap info (default provider + install state + identity)', async () => {
    const result = await pick(harness(), 'get', '/providers/bootstrap')(req());
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      defaultProvider: 'agency',
      providers: [
        { id: 'copilot', installed: true },
        { id: 'agency', installed: false },
      ],
      microsoftSignedIn: true,
    });
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
