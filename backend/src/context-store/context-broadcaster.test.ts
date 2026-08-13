import { describe, expect, it, vi } from 'vitest';
import type { Feature } from '../feature/feature-contract.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { Session } from '../session/session-contract.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import { contextDefaults } from './config.js';
import type { ContextDocument } from './context-contract.js';
import { createContextBroadcaster } from './context-broadcaster.js';

function feat(id: string, repoId: string | null): Feature {
  return {
    id,
    name: id,
    description: '',
    createdAt: '2025-01-01T00:00:00.000Z',
    summary: null,
    repoId,
  } as Feature;
}

function sess(id: string, featureId: string, status: string): Session {
  return { id, featureId, status } as unknown as Session;
}

function harness(sessionsByFeature: Record<string, Session[]>) {
  const features = {
    list: () => [feat('f1', 'r1'), feat('f2', 'r1'), feat('f3', 'r2')],
  } as unknown as FeatureService;
  const sessions = {
    listByFeature: (featureId: string) => sessionsByFeature[featureId] ?? [],
  } as unknown as SessionRepo;
  const inject = vi.fn((_sessionId: string, _text: string) => true);
  const broadcaster = createContextBroadcaster({
    features,
    sessions,
    inject,
    config: contextDefaults,
  });
  return { broadcaster, inject };
}

function doc(overrides: Partial<ContextDocument>): ContextDocument {
  return {
    scope: 'feature',
    scopeId: 'f1',
    content: '',
    updatedAt: 't',
    updatedBy: 'merge',
    ...overrides,
  };
}

describe('context-broadcaster', () => {
  it('pushes only to running sessions of the changed feature', () => {
    const h = harness({
      f1: [sess('s1', 'f1', 'running'), sess('s2', 'f1', 'completed')],
    });
    h.broadcaster.onUpdated(doc({ scope: 'feature', scopeId: 'f1' }));
    expect(h.inject).toHaveBeenCalledTimes(1);
    expect(h.inject).toHaveBeenCalledWith('s1', expect.stringContaining('feature'));
  });

  it('fans a repo change out to all of that repo\'s features', () => {
    const h = harness({
      f1: [sess('s1', 'f1', 'running')],
      f2: [sess('s2', 'f2', 'running')],
      f3: [sess('s3', 'f3', 'running')],
    });
    h.broadcaster.onUpdated(doc({ scope: 'repo', scopeId: 'r1' }));
    expect(h.inject.mock.calls.map((c) => c[0])).toEqual(['s1', 's2']);
  });

  it('fans a workspace change out to every running session, deduped', () => {
    const shared = sess('s1', 'f1', 'running');
    const h = harness({ f1: [shared, shared], f3: [sess('s3', 'f3', 'running')] });
    h.broadcaster.onUpdated(doc({ scope: 'workspace', scopeId: '' }));
    expect(h.inject.mock.calls.map((c) => c[0])).toEqual(['s1', 's3']);
  });
});
