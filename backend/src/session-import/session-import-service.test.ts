import { describe, it, expect } from 'vitest';
import { createSessionImportService } from './session-import-service.js';
import { createProviderRegistry } from '../provider/provider-registry.js';
import { NotFoundError, ConflictError } from '../kernel/error-types.js';
import type { IAIProvider, ImportableSession } from '../provider/provider-contract.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { Session } from '../session/session-contract.js';
import { sessionDefaults } from '../session/config.js';

function importable(overrides: Partial<ImportableSession> = {}): ImportableSession {
  return {
    externalId: 'ext-1',
    provider: 'agency',
    title: 'A session',
    cwd: '/work',
    repository: 'org/repo',
    branch: 'main',
    model: 'gpt-5.4',
    messageCount: 3,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-02T00:00:00Z',
    ...overrides,
  };
}

function provider(id: string, list?: ImportableSession[]): IAIProvider {
  return {
    id,
    listModels: async () => [],
    startSession: () => {
      throw new Error('unused');
    },
    buildInteractiveCommand: () => ({ command: id, args: [], env: {} }),
    ...(list ? { listImportableSessions: () => list } : {}),
  };
}

function fakeSessions(seed: Session[] = []) {
  const map = new Map<string, Session>(seed.map((s) => [s.id, s]));
  const repo: SessionRepo = {
    save: (s) => {
      map.set(s.id, s);
    },
    get: (id) => map.get(id) ?? null,
    listByFeature: (fid) => [...map.values()].filter((s) => s.featureId === fid),
    listAll: () => [...map.values()],
    delete: () => {},
    deleteByFeature: () => {},
    rename: (id, name) => {
      const s = map.get(id);
      if (s) {
        map.set(id, { ...s, name });
      }
    },
  };
  return { repo, map };
}

function fakeFeatures(known = new Set(['f1'])): FeatureService {
  return {
    create: () => {
      throw new Error('unused');
    },
    get: (id: string) => {
      if (!known.has(id)) {
        throw new NotFoundError(`Unknown feature: ${id}`);
      }
      return { id, name: id, description: '', createdAt: 'x' };
    },
    list: () => [],
    rename: () => {
      throw new Error('unused');
    },
    remove: () => {},
  } as unknown as FeatureService;
}

const clock = { now: () => new Date('2025-06-01T00:00:00Z'), isoNow: () => '2025-06-01T00:00:00Z' };

function build(providers: IAIProvider[], sessions = fakeSessions().repo, features = fakeFeatures()) {
  const registry = createProviderRegistry();
  for (const p of providers) {
    registry.register(p);
  }
  return createSessionImportService({
    providers: registry,
    sessions,
    features,
    clock,
    config: sessionDefaults,
  });
}

describe('session-import-service', () => {
  it('aggregates importable sessions across capable providers, newest first', () => {
    const service = build([
      provider('agency', [
        importable({ externalId: 'a', updatedAt: '2025-01-01T00:00:00Z' }),
        importable({ externalId: 'b', updatedAt: '2025-03-01T00:00:00Z' }),
      ]),
      provider('other'), // no capability -> skipped
    ]);
    expect(service.listImportable().map((s) => s.externalId)).toEqual(['b', 'a']);
  });

  it('excludes sessions that are already imported', () => {
    const seeded = fakeSessions([
      { id: 'a', featureId: 'f1' } as Session,
    ]).repo;
    const service = build(
      [provider('agency', [importable({ externalId: 'a' }), importable({ externalId: 'c' })])],
      seeded,
    );
    expect(service.listImportable().map((s) => s.externalId)).toEqual(['c']);
  });

  it('imports a session as a completed Session keyed by the external id', () => {
    const { repo, map } = fakeSessions();
    const service = build([provider('agency', [importable({ externalId: 'ext-9' })])], repo);
    const session = service.import({ featureId: 'f1', provider: 'agency', externalId: 'ext-9' });
    expect(session).toMatchObject({
      id: 'ext-9',
      featureId: 'f1',
      name: 'A session',
      provider: 'agency',
      requestedModel: 'gpt-5.4',
      resolvedModel: 'gpt-5.4',
      status: 'completed',
      kind: 'dev',
      prompt: 'A session',
      createdAt: '2025-01-01T00:00:00Z',
      endedAt: '2025-01-02T00:00:00Z',
      exitCode: 0,
    });
    expect(session.usageFilePath).toContain('ext-9');
    expect(map.get('ext-9')).toBeDefined();
  });

  it('defaults model to auto when unknown', () => {
    const service = build([
      provider('agency', [importable({ externalId: 'ext-nm', model: null })]),
    ]);
    const session = service.import({ featureId: 'f1', provider: 'agency', externalId: 'ext-nm' });
    expect(session.requestedModel).toBe('auto');
    expect(session.resolvedModel).toBeNull();
  });

  it('throws NotFoundError when the feature does not exist', () => {
    const service = build([provider('agency', [importable()])]);
    expect(() =>
      service.import({ featureId: 'missing', provider: 'agency', externalId: 'ext-1' }),
    ).toThrow(NotFoundError);
  });

  it('throws NotFoundError when the external session is not importable', () => {
    const service = build([provider('agency', [importable({ externalId: 'ext-1' })])]);
    expect(() =>
      service.import({ featureId: 'f1', provider: 'agency', externalId: 'nope' }),
    ).toThrow(NotFoundError);
  });

  it('throws ConflictError when the session is already imported', () => {
    const seeded = fakeSessions([{ id: 'ext-1', featureId: 'f1' } as Session]).repo;
    const service = build([provider('agency', [importable({ externalId: 'ext-1' })])], seeded);
    expect(() =>
      service.import({ featureId: 'f1', provider: 'agency', externalId: 'ext-1' }),
    ).toThrow(ConflictError);
  });
});
