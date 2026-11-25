import { describe, it, expect, vi } from 'vitest';
import { createProviderRoutes } from './provider-controller.js';
import { createProviderRegistry } from '../provider/provider-registry.js';
import type { IAIProvider, ModelInfo } from '../provider/provider-contract.js';
import type { HttpRequest, Route } from './http-contract.js';
import { createActiveProviderPolicy } from '../provider/active-provider.js';
import { ConflictError } from '../kernel/error-types.js';
import { createMicrosoftNetworkDetector } from '../provider/network-environment.js';

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
    isProviderEligible: (id) => id !== 'agency' || signedIn,
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
  it('uses detected connectivity, not sign-in, without selecting Agency and revokes availability after network loss', async () => {
    let reachable = false;
    let signedIn = true;
    const detector = createMicrosoftNetworkDetector({ probe: async () => reachable });
    const registry = createProviderRegistry();
    registry.register(provider('copilot', []));
    registry.register(provider('agency', []));
    const saveSelected = vi.fn();
    const executionPolicy = createActiveProviderPolicy({
      initialProviderId: 'copilot', enabledProviderIds: () => ['copilot', 'agency'],
      isEligible: (id) => id !== 'agency' || detector.isMicrosoftNetwork(), saveSelected,
    });
    const routes = createProviderRoutes({
      registry, executionPolicy, microsoftSignedIn: () => signedIn,
      bootstrapInfo: () => ({ defaultProvider: 'copilot',
        providers: [{ id: 'copilot', installed: true }, { id: 'agency', installed: true }],
      }),
    });
    const bootstrap = () => pick(routes, 'get', '/providers/bootstrap')(req());
    await detector.refresh();
    expect((await bootstrap()).body).toMatchObject({ providers: [{ id: 'copilot' }] });
    reachable = true;
    signedIn = false;
    await detector.refresh();
    expect((await bootstrap()).body).toMatchObject({
      defaultProvider: 'copilot', providers: [{ id: 'copilot' }, { id: 'agency' }],
    });
    expect(saveSelected).not.toHaveBeenCalled();
    reachable = false;
    signedIn = true;
    await detector.refresh();
    expect((await bootstrap()).body).toMatchObject({ providers: [{ id: 'copilot' }] });
    expect(() => pick(routes, 'post', '/providers/selection')(req({
      body: { providerId: 'agency' },
    }))).toThrow('Provider is not available');
  });

  it('exposes automation restrictions separately from interactive installation on catalog, setup and selection responses', async () => {
    const registry = createProviderRegistry();
    registry.register(provider('copilot', []));
    registry.register(provider('agency', []));
    const automation = { supported: false, reason: 'Interactive sessions remain available. Native MCP policy cannot safely support automated work; choose another provider.' };
    const features = [{ id: 'future', label: 'Future feature', status: 'setup-required' as const, reason: 'Configure native CLI' }];
    const executionPolicy = createActiveProviderPolicy({
      initialProviderId: 'copilot', enabledProviderIds: () => ['copilot', 'agency'],
      isEligible: () => true, saveSelected: () => {},
    });
    const routes = createProviderRoutes({
      registry, executionPolicy, microsoftSignedIn: () => false,
      bootstrapInfo: () => ({
        defaultProvider: 'copilot', providers: [
          { id: 'copilot', installed: true, automation: { supported: true, reason: null } },
          { id: 'agency', installed: true, automation, features },
        ],
      }),
    });
    expect((await pick(routes, 'get', '/providers')(req())).body).toEqual([
      { id: 'copilot', installed: true, automation: { supported: true, reason: null } },
      { id: 'agency', installed: true, automation, features },
    ]);
    expect((await pick(routes, 'get', '/providers/bootstrap')(req())).body).toMatchObject({
      providers: [{ id: 'copilot' }, { id: 'agency', installed: true, automation }],
    });
    expect((await pick(routes, 'post', '/providers/selection')(req({ body: { providerId: 'agency' } }))).body).toMatchObject({
      defaultProvider: 'agency', providers: [{ id: 'copilot' }, { id: 'agency', automation }],
    });
  });

  it('updates internal Agency attestation explicitly, without selecting or launching a provider', async () => {
    let enabled = false;
    const updateInternalAgencyOptIn = vi.fn((value: boolean) => { enabled = value; });
    const executionPolicy = createActiveProviderPolicy({
      initialProviderId: 'copilot', enabledProviderIds: () => ['copilot', 'agency'],
      isEligible: (id) => id !== 'agency' || enabled, saveSelected: () => {},
    });
    const routes = createProviderRoutes({
      registry: createProviderRegistry(), executionPolicy, updateInternalAgencyOptIn, microsoftSignedIn: () => true,
      bootstrapInfo: () => ({
        defaultProvider: 'copilot', internalAgencyEnabled: enabled,
        providers: [{ id: 'copilot', installed: true }, { id: 'agency', installed: true }],
      }),
    });
    const handler = pick(routes, 'put', '/providers/preferences');
    expect(() => handler(req({ body: {} }))).toThrow('explicit');
    const result = await handler(req({ body: { allowInternalAgency: true } }));
    expect(result.body).toMatchObject({ internalAgencyEnabled: true, defaultProvider: 'copilot', providers: [
      { id: 'copilot', installed: true }, { id: 'agency', installed: true },
    ] });
    expect(updateInternalAgencyOptIn).toHaveBeenCalledWith(true);
    executionPolicy.select('agency');
    expect(() => handler(req({ body: { allowInternalAgency: false } }))).toThrow('Choose another CLI');
    executionPolicy.select('copilot');
    expect((await handler(req({ body: { allowInternalAgency: false } }))).body).toMatchObject({
      internalAgencyEnabled: false, providers: [{ id: 'copilot', installed: true }],
    });
    updateInternalAgencyOptIn.mockImplementation(() => { throw new Error('disk full'); });
    expect(() => handler(req({ body: { allowInternalAgency: true } }))).toThrow('disk full');
    expect(enabled).toBe(false);
  });

  it('refuses unconfigured internal attestation and supports preference configuration without execution wiring', async () => {
    const base = {
      registry: createProviderRegistry(), microsoftSignedIn: () => false,
      bootstrapInfo: () => ({ defaultProvider: 'copilot', providers: [] }),
    };
    const input = req({ body: { allowInternalAgency: false } });
    expect(() => pick(createProviderRoutes(base), 'put', '/providers/preferences')(input)).toThrow('not configured');
    const updateInternalAgencyOptIn = vi.fn();
    expect((await pick(createProviderRoutes({ ...base, updateInternalAgencyOptIn }), 'put', '/providers/preferences')(input)).status).toBe(200);
  });
  it('switches installed providers through an explicit drain and returns the remember preference', async () => {
    const registry = createProviderRegistry();
    const saveSelected = vi.fn();
    const executionPolicy = createActiveProviderPolicy({
      initialProviderId: 'copilot', enabledProviderIds: () => ['copilot', 'claude'],
      isEligible: () => true, saveSelected,
    });
    const lease = executionPolicy.acquire('copilot', { kind: 'terminal', id: 's', label: 'Interactive terminal' });
    const drainProviderWork = vi.fn(async () => { lease.release(); });
    const routes = createProviderRoutes({
      registry, executionPolicy, drainProviderWork, microsoftSignedIn: () => false,
      bootstrapInfo: () => ({ defaultProvider: 'copilot', providers: [
        { id: 'copilot', installed: true }, { id: 'claude', installed: true },
      ] }),
    });
    const handler = pick(routes, 'post', '/providers/switch');
    expect(await handler(req({ body: { providerId: 'claude', remember: false, expectedRevision: 0 } }))).toMatchObject({
      status: 200, body: { defaultProvider: 'claude', remember: false, revision: 1 },
    });
    expect(saveSelected).toHaveBeenCalledWith(null);
    expect(drainProviderWork).toHaveBeenCalledTimes(1);
    expect(await handler(req({ body: { providerId: 'copilot', remember: true, expectedRevision: 0 } }))).toMatchObject({
      status: 409, body: { error: { blockers: [] } },
    });
    expect(drainProviderWork).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid, unconfigured, uninstalled and ineligible switch requests before drain', async () => {
    const registry = createProviderRegistry();
    const bootstrapInfo = () => ({ defaultProvider: 'copilot', providers: [{ id: 'copilot', installed: false }] });
    const executionPolicy = createActiveProviderPolicy({
      initialProviderId: null, enabledProviderIds: () => ['copilot'], isEligible: () => true, saveSelected: () => {},
    });
    const drainProviderWork = vi.fn(async () => {});
    const base = { registry, bootstrapInfo, microsoftSignedIn: () => false };
    const input = req({ body: { providerId: 'copilot', remember: false, expectedRevision: 0 } });
    const missing = pick(createProviderRoutes(base), 'post', '/providers/switch');
    await expect(missing(req({ body: {} }))).rejects.toThrow('providerId');
    await expect(missing(input)).rejects.toThrow('not configured');
    await expect(pick(createProviderRoutes({ ...base, executionPolicy }), 'post', '/providers/switch')(input)).rejects.toThrow('not configured');
    const configured = pick(createProviderRoutes({ ...base, executionPolicy, drainProviderWork }), 'post', '/providers/switch');
    await expect(configured(input)).rejects.toThrow('Install');
    await expect(configured(req({ body: { providerId: 'agency', remember: true, expectedRevision: 0 } }))).rejects.toThrow('not available');
    expect(drainProviderWork).not.toHaveBeenCalled();
  });

  it('sanitizes switch conflicts and propagates save/drain failures without changing selection', async () => {
    const executionPolicy = createActiveProviderPolicy({
      initialProviderId: 'copilot', enabledProviderIds: () => ['copilot', 'claude'],
      isEligible: () => true, saveSelected: () => {},
    });
    const drainProviderWork = vi.fn(async () => { throw new ConflictError('Waiting for native exit', {
      blockers: [{ kind: 'terminal', id: 's', label: 'CLI', secret: 'private' }], secret: 'private',
    }); });
    const handler = pick(createProviderRoutes({
      registry: createProviderRegistry(), executionPolicy, drainProviderWork, microsoftSignedIn: () => false,
      bootstrapInfo: () => ({ defaultProvider: 'copilot', providers: [{ id: 'claude', installed: true }] }),
    }), 'post', '/providers/switch');
    const input = req({ body: { providerId: 'claude', remember: true, expectedRevision: 0 } });
    expect(await handler(input)).toEqual({ status: 409, body: {
      error: { kind: 'conflict', message: 'Waiting for native exit', blockers: [{ kind: 'terminal', id: 's', label: 'CLI' }] },
    } });
    drainProviderWork.mockRejectedValueOnce(new ConflictError('busy'));
    expect(await handler(input)).toMatchObject({ status: 409, body: { error: { blockers: [] } } });
    drainProviderWork.mockRejectedValueOnce(new Error('disk full'));
    await expect(handler(input)).rejects.toThrow('disk full');
    expect(executionPolicy.get().providerId).toBe('copilot');
  });
  it('does not leak arbitrary conflict details and preserves persistence failures', async () => {
    const registry = createProviderRegistry();
    registry.register(provider('copilot', []));
    const executionPolicy = createActiveProviderPolicy({
      initialProviderId: null, enabledProviderIds: () => ['copilot'],
      isEligible: () => true, saveSelected: () => { throw new Error('disk full'); },
    });
    const routes = createProviderRoutes({
      registry, executionPolicy, microsoftSignedIn: () => false,
      bootstrapInfo: () => ({ defaultProvider: 'copilot', providers: [] }),
    });
    const select = pick(routes, 'post', '/providers/selection');
    const request = req({ body: { providerId: 'copilot' } });
    expect(() => select(request)).toThrow('disk full');
    const spy = vi.spyOn(executionPolicy, 'select').mockImplementation(() => {
      throw new ConflictError('busy', {
        secret: 'not public', blockers: [{ kind: 'probe', id: 'p', label: 'Quota probe', secret: 'private' }],
      });
    });
    expect((await select(request)).body).toEqual({
      error: { kind: 'conflict', message: 'busy', blockers: [{ kind: 'probe', id: 'p', label: 'Quota probe' }] },
    });
    spy.mockImplementation(() => { throw new ConflictError('busy'); });
    expect((await select(request)).body).toEqual({ error: { kind: 'conflict', message: 'busy', blockers: [] } });
  });
  it('fails closed for Agency on every read and mutation without approved eligibility', async () => {
    const registry = createProviderRegistry();
    registry.register(provider('copilot', []));
    registry.register(provider('agency', []));
    const routes = createProviderRoutes({
      registry, microsoftSignedIn: () => true,
      bootstrapInfo: () => ({ defaultProvider: 'agency', providers: [{ id: 'agency', installed: true }] }),
    });
    expect((await pick(routes, 'get', '/providers')(req())).body).toEqual([{ id: 'copilot', installed: false }]);
    expect((await pick(routes, 'get', '/providers/bootstrap')(req())).body).toMatchObject({ providers: [] });
    await expect(pick(routes, 'get', '/providers/:id/models')(req({ params: { id: 'agency' } }))).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => pick(routes, 'post', '/providers/selection')(req({ body: { providerId: 'agency' } }))).toThrow('not configured');
  });

  it('returns selection state and validates all selection mutation denials', async () => {
    const registry = createProviderRegistry();
    registry.register(provider('copilot', []));
    const executionPolicy = createActiveProviderPolicy({
      initialProviderId: null, enabledProviderIds: () => ['copilot', 'claude'],
      isEligible: () => true, saveSelected: () => {},
    });
    const routes = createProviderRoutes({
      registry, executionPolicy, microsoftSignedIn: () => false,
      bootstrapInfo: () => ({ defaultProvider: 'copilot', providers: [{ id: 'copilot', installed: true }] }),
    });
    const get = pick(routes, 'get', '/providers/bootstrap');
    const select = pick(routes, 'post', '/providers/selection');
    expect((await get(req())).body).toMatchObject({ selectionRequired: true, revision: 0, blockers: [] });
    expect(() => select(req({ body: {} }))).toThrow('providerId');
    expect(() => select(req({ body: { providerId: 'agency' } }))).toThrow('not available');
    expect((await select(req({ body: { providerId: 'copilot' } }))).body).toMatchObject({
      selectionRequired: false, revision: 1, defaultProvider: 'copilot',
    });
    const lease = executionPolicy.acquire();
    expect(await select(req({ body: { providerId: 'claude' } }))).toEqual({
      status: 409,
      body: { error: { kind: 'conflict', message: 'Stop all CLI work before switching providers',
        blockers: [{ kind: 'execution', id: '1', label: 'CLI execution' }] } },
    });
    lease.release();
    expect((await select(req({ body: { providerId: 'claude' } }))).body).toMatchObject({ defaultProvider: 'claude', revision: 2 });
  });
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
