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

function harness(featureSessions: Session[] = []) {
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
    terminals: {
      close: (id) => calls.push(`terminals.close:${id}`),
    },
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

  it('cascades feature deletion across sessions, usage, transcripts and summary', async () => {
    const { admin, calls } = harness([session('s1'), session('s2')]);
    await admin.deleteFeature('f1');
    expect(calls).toEqual([
      'feature.get:f1',
      'sessions.listByFeature:f1',
      'terminals.close:s1',
      'usage.deleteBySession:s1',
      'transcripts.delete:s1',
      'terminals.close:s2',
      'usage.deleteBySession:s2',
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
