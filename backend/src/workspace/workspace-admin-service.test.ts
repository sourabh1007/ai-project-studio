import { describe, it, expect } from 'vitest';
import { createWorkspaceAdmin } from './workspace-admin-service.js';
import { NotFoundError } from '../kernel/error-types.js';
import type { Feature } from '../feature/feature-contract.js';
import type { Session } from '../session/session-contract.js';

function feature(id = 'f1'): Feature {
  return {
    id,
    name: 'Login',
    description: 'Build login',
    createdAt: '2025-01-01T00:00:00.000Z',
    summary: null,
  };
}

function session(id: string, featureId = 'f1'): Session {
  return {
    id,
    featureId,
    name: null,
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'completed',
    kind: 'dev',
    prompt: 'do it',
    usageFilePath: `usage/${id}.jsonl`,
    createdAt: '2025-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    exitCode: null,
  };
}

function harness(
  featureSessions: Session[] = [],
  options: { withPrReviews?: boolean; withContext?: boolean } = {},
) {
  const calls: string[] = [];
  const known = new Map<string, Session>(
    featureSessions.map((s) => [s.id, s]),
  );
  const admin = createWorkspaceAdmin({
    features: {
      get: (id) => {
        if (id !== 'f1') {
          throw new NotFoundError(`Unknown feature: ${id}`);
        }
        calls.push(`feature.get:${id}`);
        return feature(id);
      },
      rename: (id, name) => {
        calls.push(`feature.rename:${id}:${name}`);
        return { ...feature(id), name };
      },
      remove: (id) => calls.push(`feature.remove:${id}`),
    },
    sessions: {
      get: (id) => known.get(id) ?? null,
      listByFeature: (featureId) => {
        calls.push(`sessions.listByFeature:${featureId}`);
        return featureSessions.filter((s) => s.featureId === featureId);
      },
      rename: (id, name) => {
        calls.push(`sessions.rename:${id}:${name ?? ''}`);
        const existing = known.get(id);
        if (existing) {
          known.set(id, { ...existing, name });
        }
      },
      delete: (id) => calls.push(`sessions.delete:${id}`),
      deleteByFeature: (featureId) =>
        calls.push(`sessions.deleteByFeature:${featureId}`),
    },
    usage: {
      deleteBySession: (id) => calls.push(`usage.deleteBySession:${id}`),
    },
    transcripts: {
      delete: async (id) => {
        calls.push(`transcripts.delete:${id}`);
      },
    },
    summaries: {
      delete: (featureId) => calls.push(`summaries.delete:${featureId}`),
    },
    sessionFiles: {
      deleteBySession: (id) => calls.push(`sessionFiles.deleteBySession:${id}`),
    },
    terminals: {
      close: (id) => calls.push(`terminals.close:${id}`),
    },
    prReviews: options.withPrReviews
      ? { removeForFeature: (id) => calls.push(`prReviews.removeForFeature:${id}`) }
      : undefined,
    sharedContext: options.withContext
      ? { remove: (scope, id) => calls.push(`context.remove:${scope}:${id}`) }
      : undefined,
  });
  return { admin, calls };
}

describe('workspace-admin-service', () => {
  it('renames a feature via the feature service', () => {
    const { admin, calls } = harness();
    const result = admin.renameFeature('f1', 'Sign in');
    expect(result.name).toBe('Sign in');
    expect(calls).toEqual(['feature.rename:f1:Sign in']);
  });

  it('renames a session, trimming and returning the updated record', () => {
    const { admin, calls } = harness([session('s1')]);
    const result = admin.renameSession('s1', '  Auth spike  ');
    expect(result.name).toBe('Auth spike');
    expect(calls).toEqual(['sessions.rename:s1:Auth spike']);
  });

  it('clears a session name to null when given blank input', () => {
    const { admin, calls } = harness([session('s1')]);
    const result = admin.renameSession('s1', '   ');
    expect(result.name).toBeNull();
    expect(calls).toEqual(['sessions.rename:s1:']);
  });

  it('clears a session name to null when given null', () => {
    const { admin } = harness([session('s1')]);
    expect(admin.renameSession('s1', null).name).toBeNull();
  });

  it('throws NotFound when renaming an unknown session', () => {
    const { admin } = harness([session('s1')]);
    expect(() => admin.renameSession('ghost', 'x')).toThrow(NotFoundError);
  });

  it('cascades feature deletion across sessions, usage, transcripts and summary', async () => {
    const { admin, calls } = harness([session('s1'), session('s2')]);
    await admin.deleteFeature('f1');
    expect(calls).toEqual([
      'feature.get:f1',
      'sessions.listByFeature:f1',
      'terminals.close:s1',
      'usage.deleteBySession:s1',
      'sessionFiles.deleteBySession:s1',
      'transcripts.delete:s1',
      'terminals.close:s2',
      'usage.deleteBySession:s2',
      'sessionFiles.deleteBySession:s2',
      'transcripts.delete:s2',
      'sessions.deleteByFeature:f1',
      'summaries.delete:f1',
      'feature.remove:f1',
    ]);
  });

  it('deletes a feature with no sessions', async () => {
    const { admin, calls } = harness();
    await admin.deleteFeature('f1');
    expect(calls).toEqual([
      'feature.get:f1',
      'sessions.listByFeature:f1',
      'sessions.deleteByFeature:f1',
      'summaries.delete:f1',
      'feature.remove:f1',
    ]);
  });

  it('purges a feature shared-context document when a remover is wired', async () => {
    const { admin, calls } = harness([], { withContext: true });
    await admin.deleteFeature('f1');
    expect(calls).toEqual([
      'feature.get:f1',
      'sessions.listByFeature:f1',
      'sessions.deleteByFeature:f1',
      'summaries.delete:f1',
      'context.remove:feature:f1',
      'feature.remove:f1',
    ]);
  });

  it('purges a feature PR review when a remover is wired', async () => {
    const { admin, calls } = harness([], { withPrReviews: true });
    await admin.deleteFeature('f1');
    expect(calls).toEqual([
      'feature.get:f1',
      'sessions.listByFeature:f1',
      'sessions.deleteByFeature:f1',
      'summaries.delete:f1',
      'prReviews.removeForFeature:f1',
      'feature.remove:f1',
    ]);
  });

  it('propagates NotFound when deleting an unknown feature', async () => {
    const { admin } = harness();
    await expect(admin.deleteFeature('nope')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('deletes a single session and tears down its terminal and data', async () => {
    const { admin, calls } = harness([session('s1')]);
    await admin.deleteSession('s1');
    expect(calls).toEqual([
      'terminals.close:s1',
      'usage.deleteBySession:s1',
      'sessionFiles.deleteBySession:s1',
      'transcripts.delete:s1',
      'sessions.delete:s1',
    ]);
  });

  it('throws NotFound when deleting an unknown session', async () => {
    const { admin } = harness([session('s1')]);
    await expect(admin.deleteSession('ghost')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
