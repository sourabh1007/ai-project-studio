import { describe, it, expect } from 'vitest';
import { createTerminalRoutes } from './terminal-controller.js';
import { createProviderResolver } from '../provider/provider-resolver.js';
import { createProviderRegistry } from '../provider/provider-registry.js';
import { createSessionFactory } from '../session/session-factory.js';
import { createIdGenerator } from '../kernel/id-generator.js';
import { createClock } from '../kernel/clock.js';
import { sessionDefaults } from '../session/config.js';
import type { IAIProvider } from '../provider/provider-contract.js';
import type { Session } from '../session/session-contract.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { HttpRequest, Route } from './http-contract.js';

function provider(): IAIProvider {
  return {
    id: 'copilot',
    listModels: async () => [{ id: 'gpt-5.4', label: 'G' }],
    startSession: () => {
      throw new Error('unused');
    },
    buildInteractiveCommand: () => {
      throw new Error('unused');
    },
  };
}

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

function harness() {
  const registry = createProviderRegistry();
  registry.register(provider());
  const resolver = createProviderResolver(registry, {
    defaultProvider: 'copilot',
    defaultModelByProvider: { copilot: 'auto' },
  });
  const factory = createSessionFactory({
    ids: createIdGenerator(() => 'sess-1'),
    clock: createClock(() => 0),
    config: sessionDefaults,
  });
  const saved: Session[] = [];
  const sessions = {
    save: (s: Session) => saved.push(s),
    get: () => null,
    listByFeature: () => [],
  } as unknown as SessionRepo;
  const routes = createTerminalRoutes({
    resolver,
    factory,
    sessions,
    config: sessionDefaults,
  });
  return { routes, saved };
}

describe('terminal-controller', () => {
  it('creates and persists an interactive session record (201)', async () => {
    const h = harness();
    const result = await pick(
      h.routes,
      'post',
      '/features/:featureId/terminal-sessions',
    )(req({ params: { featureId: 'feat-1' }, body: { model: 'gpt-5.4' } }));

    expect(result.status).toBe(201);
    const session = result.body as Session;
    expect(session.id).toBe('sess-1');
    expect(session.featureId).toBe('feat-1');
    expect(session.provider).toBe('copilot');
    expect(session.requestedModel).toBe('gpt-5.4');
    expect(session.status).toBe('created');
    expect(session.prompt).toBe('');
    expect(h.saved).toHaveLength(1);
  });

  it('applies the default kind and resolves the default provider/model', async () => {
    const h = harness();
    const result = await pick(
      h.routes,
      'post',
      '/features/:featureId/terminal-sessions',
    )(req({ params: { featureId: 'feat-1' }, body: {} }));

    const session = result.body as Session;
    expect(session.kind).toBe(sessionDefaults.defaultKind);
    expect(session.requestedModel).toBe('auto');
  });

  it('honours an explicit kind', async () => {
    const h = harness();
    const result = await pick(
      h.routes,
      'post',
      '/features/:featureId/terminal-sessions',
    )(req({ params: { featureId: 'feat-1' }, body: { kind: 'meta' } }));

    expect((result.body as Session).kind).toBe('meta');
  });

  it('rejects an invalid model type', async () => {
    const h = harness();
    await expect(
      pick(h.routes, 'post', '/features/:featureId/terminal-sessions')(
        req({ params: { featureId: 'feat-1' }, body: { model: 123 } }),
      ),
    ).rejects.toMatchObject({ kind: 'validation' });
  });
});
