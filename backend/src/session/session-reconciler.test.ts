import { describe, it, expect } from 'vitest';
import { createSessionReconciler } from './session-reconciler.js';
import { createClock } from '../kernel/clock.js';
import type { Session, SessionStatus } from './session-contract.js';
import type { SessionRepo } from './session-repo-port.js';

function session(overrides: Partial<Session>): Session {
  return {
    id: 's',
    featureId: 'f1',
    name: null,
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'running',
    kind: 'dev',
    prompt: 'p',
    usageFilePath: '/tmp/u.jsonl',
    createdAt: '2025-01-01T00:00:00.000Z',
    startedAt: '2025-01-01T00:00:01.000Z',
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function fakeRepo(initial: Session[]): {
  repo: SessionRepo;
  saved: Session[];
} {
  const store = new Map(initial.map((s) => [s.id, s]));
  const saved: Session[] = [];
  const repo: SessionRepo = {
    save(s) {
      store.set(s.id, s);
      saved.push(s);
    },
    get: (id) => store.get(id) ?? null,
    listByFeature: (featureId) =>
      [...store.values()].filter((s) => s.featureId === featureId),
    listByFeatureAll: (featureId) =>
      [...store.values()].filter((s) => s.featureId === featureId),
    listAll: () => [...store.values()],
    updatePlacement: () => {},
    delete: (id) => {
      store.delete(id);
    },
    deleteByFeature: (featureId) => {
      for (const [id, s] of store) {
        if (s.featureId === featureId) {
          store.delete(id);
        }
      }
    },
    rename: (id, name) => {
      const s = store.get(id);
      if (s) {
        store.set(id, { ...s, name });
      }
    },
  };
  return { repo, saved };
}

const NOW = '2025-06-01T12:00:00.000Z';
const clock = createClock(() => Date.parse(NOW));

describe('session-reconciler', () => {
  it('cancels running and created orphans, stamping an end time', () => {
    const { repo, saved } = fakeRepo([
      session({ id: 'running', status: 'running', endedAt: null }),
      session({ id: 'created', status: 'created', startedAt: null, endedAt: null }),
    ]);
    const count = createSessionReconciler({ sessions: repo, clock }).reconcileOrphans();
    expect(count).toBe(2);
    expect(repo.get('running')?.status).toBe('cancelled');
    expect(repo.get('running')?.endedAt).toBe(NOW);
    expect(repo.get('created')?.status).toBe('cancelled');
    expect(repo.get('created')?.endedAt).toBe(NOW);
    expect(saved).toHaveLength(2);
  });

  it('preserves an existing end time when present', () => {
    const existing = '2025-05-30T00:00:00.000Z';
    const { repo } = fakeRepo([
      session({ id: 'running', status: 'running', endedAt: existing }),
    ]);
    createSessionReconciler({ sessions: repo, clock }).reconcileOrphans();
    expect(repo.get('running')?.endedAt).toBe(existing);
  });

  it('leaves terminal sessions untouched', () => {
    const terminal: SessionStatus[] = ['completed', 'failed', 'cancelled'];
    const { repo, saved } = fakeRepo(
      terminal.map((status, i) => session({ id: `t${i}`, status })),
    );
    const count = createSessionReconciler({ sessions: repo, clock }).reconcileOrphans();
    expect(count).toBe(0);
    expect(saved).toHaveLength(0);
  });
});
