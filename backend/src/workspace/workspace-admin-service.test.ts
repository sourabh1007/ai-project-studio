import { describe, it, expect } from 'vitest';
import { createWorkspaceAdmin, type WorkspaceQuiescence } from './workspace-admin-service.js';
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
  options: {
    withPrReviews?: boolean;
    withContext?: boolean;
    withWorktrees?: boolean;
    worktreeFails?: boolean;
    withoutLiveUsage?: boolean;
    withCaptureCleanup?: boolean;
    withMetaUsageCleanup?: boolean;
    withMetaOperationsCleanup?: boolean;
    withSessionSummaries?: boolean;
    withOwnedAutomationCleanup?: boolean;
    withOwnedSubagentCleanup?: boolean;
    quiescence?: WorkspaceQuiescence;
  } = {},
) {
  const calls: string[] = [];
  const known = new Map<string, Session>(
    featureSessions.map((s) => [s.id, s]),
  );
  const admin = createWorkspaceAdmin({
    quiescence: options.quiescence ?? {
      feature: async () => {},
      session: async () => {},
    },
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
      listByFeatureAll: (featureId) => {
        calls.push(`sessions.listByFeatureAll:${featureId}`);
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
    usageCaptures: options.withCaptureCleanup
      ? {
          deleteBySession: (id) => calls.push(`usageCaptures.deleteBySession:${id}`),
        }
      : undefined,
    metaUsage: options.withMetaUsageCleanup
      ? {
          deleteByFeature: (id) => calls.push(`metaUsage.deleteByFeature:${id}`),
          deleteBySession: (id) => calls.push(`metaUsage.deleteBySession:${id}`),
        }
      : undefined,
    metaOperations: options.withMetaOperationsCleanup
      ? {
          deleteByFeature: (id) => { calls.push(`metaOperations.deleteByFeature:${id}`); },
          deleteBySession: (id) => { calls.push(`metaOperations.deleteBySession:${id}`); },
        }
      : undefined,
    transcripts: {
      delete: async (id) => {
        calls.push(`transcripts.delete:${id}`);
      },
    },
    summaries: {
      delete: (featureId) => calls.push(`summaries.delete:${featureId}`),
    },
    sessionSummaries: options.withSessionSummaries
      ? {
          delete: (id) => calls.push(`sessionSummaries.delete:${id}`),
        }
      : undefined,
    sessionFiles: {
      deleteBySession: (id) => calls.push(`sessionFiles.deleteBySession:${id}`),
    },
    terminals: {
      close: (id) => calls.push(`terminals.close:${id}`),
    },
    liveUsage: options.withoutLiveUsage
      ? undefined
      : {
          release: (id) => calls.push(`liveUsage.release:${id}`),
        },
    prReviews: options.withPrReviews
      ? { removeForFeature: (id) => calls.push(`prReviews.removeForFeature:${id}`) }
      : undefined,
    worktrees: options.withWorktrees
      ? {
          removeForFeature: async (id) => {
            calls.push(`worktrees.removeForFeature:${id}`);
            if (options.worktreeFails) {
              throw new Error('worktree gone');
            }
          },
        }
      : undefined,
    sharedContext: options.withContext
      ? { remove: (scope, id) => calls.push(`context.remove:${scope}:${id}`) }
      : undefined,
    ownedAutomations: options.withOwnedAutomationCleanup
      ? {
          deleteByFeature: (id) => { calls.push(`ownedAutomations.deleteByFeature:${id}`); },
          deleteBySession: (id) => { calls.push(`ownedAutomations.deleteBySession:${id}`); },
        }
      : undefined,
    ownedSubagents: options.withOwnedSubagentCleanup
      ? {
          deleteByFeature: (id) => calls.push(`ownedSubagents.deleteByFeature:${id}`),
          deleteBySession: (id) => calls.push(`ownedSubagents.deleteBySession:${id}`),
        }
      : undefined,
  });
  return { admin, calls };
}

describe('workspace-admin-service', () => {
  it('purges durable meta operations by session and then feature after quiescence', async () => {
    const { admin, calls } = harness([session('s1')], { withMetaOperationsCleanup: true });
    await admin.deleteFeature('f1');
    expect(calls).toEqual(expect.arrayContaining([
      'metaOperations.deleteBySession:s1',
      'metaOperations.deleteByFeature:f1',
    ]));
    expect(calls.indexOf('metaOperations.deleteBySession:s1'))
      .toBeLessThan(calls.indexOf('metaOperations.deleteByFeature:f1'));
  });

  it('does not purge a session until its producers and final persistence have drained', async () => {
    let finish!: () => void;
    const { admin, calls } = harness([session('s1')], {
      quiescence: {
        feature: async () => {},
        session: () => new Promise<void>((resolve) => { finish = resolve; }),
      },
    });
    const deleting = admin.deleteSession('s1');
    await Promise.resolve();
    expect(calls).toEqual([]);
    finish();
    await deleting;
    expect(calls).toContain('sessions.delete:s1');
    expect(calls.indexOf('transcripts.delete:s1')).toBeLessThan(calls.indexOf('sessions.delete:s1'));
  });

  it('retains every artifact when feature quiescence is unconfirmed', async () => {
    const error = new Error('process exit unconfirmed');
    const { admin, calls } = harness([session('s1')], {
      quiescence: {
        feature: async () => { throw error; },
        session: async () => {},
      },
    });
    await expect(admin.deleteFeature('f1')).rejects.toBe(error);
    expect(calls).toEqual(['feature.get:f1']);
  });

  it('purges internal-session captures, usage, summaries and transcripts with their feature', async () => {
    const internal: Session = { ...session('internal'), scope: 'internal', kind: 'meta' };
    const { admin, calls } = harness([session('s1'), internal], {
      withCaptureCleanup: true, withMetaUsageCleanup: true, withSessionSummaries: true,
    });
    await admin.deleteFeature('f1');
    expect(calls).toEqual(expect.arrayContaining([
      'sessions.listByFeatureAll:f1',
      'usageCaptures.deleteBySession:internal',
      'metaUsage.deleteBySession:internal',
      'usage.deleteBySession:internal',
      'sessionSummaries.delete:internal',
      'transcripts.delete:internal',
    ]));
  });

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
    const { admin, calls } = harness([session('s1'), session('s2')], {
      withCaptureCleanup: true,
      withMetaUsageCleanup: true,
      withSessionSummaries: true,
      withOwnedAutomationCleanup: true,
      withOwnedSubagentCleanup: true,
    });
    await admin.deleteFeature('f1');
    expect(calls).toEqual([
      'feature.get:f1',
      'ownedAutomations.deleteByFeature:f1',
      'ownedSubagents.deleteByFeature:f1',
      'sessions.listByFeatureAll:f1',
      'ownedAutomations.deleteBySession:s1',
      'ownedSubagents.deleteBySession:s1',
      'liveUsage.release:s1',
      'terminals.close:s1',
      'usageCaptures.deleteBySession:s1',
      'metaUsage.deleteBySession:s1',
      'usage.deleteBySession:s1',
      'sessionFiles.deleteBySession:s1',
      'sessionSummaries.delete:s1',
      'transcripts.delete:s1',
      'ownedAutomations.deleteBySession:s2',
      'ownedSubagents.deleteBySession:s2',
      'liveUsage.release:s2',
      'terminals.close:s2',
      'usageCaptures.deleteBySession:s2',
      'metaUsage.deleteBySession:s2',
      'usage.deleteBySession:s2',
      'sessionFiles.deleteBySession:s2',
      'sessionSummaries.delete:s2',
      'transcripts.delete:s2',
      'sessions.deleteByFeature:f1',
      'metaUsage.deleteByFeature:f1',
      'summaries.delete:f1',
      'feature.remove:f1',
    ]);
  });

  it('deletes a feature with no sessions', async () => {
    const { admin, calls } = harness();
    await admin.deleteFeature('f1');
    expect(calls).toEqual([
      'feature.get:f1',
      'sessions.listByFeatureAll:f1',
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
      'sessions.listByFeatureAll:f1',
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
      'sessions.listByFeatureAll:f1',
      'sessions.deleteByFeature:f1',
      'summaries.delete:f1',
      'prReviews.removeForFeature:f1',
      'feature.remove:f1',
    ]);
  });

  it('removes a feature worktree before purging its review row when wired', async () => {
    const { admin, calls } = harness([], { withWorktrees: true, withPrReviews: true });
    await admin.deleteFeature('f1');
    expect(calls).toEqual([
      'feature.get:f1',
      'sessions.listByFeatureAll:f1',
      'sessions.deleteByFeature:f1',
      'summaries.delete:f1',
      'worktrees.removeForFeature:f1',
      'prReviews.removeForFeature:f1',
      'feature.remove:f1',
    ]);
  });

  it('continues feature deletion when worktree removal fails', async () => {
    const { admin, calls } = harness([], { withWorktrees: true, worktreeFails: true });
    await admin.deleteFeature('f1');
    expect(calls).toEqual([
      'feature.get:f1',
      'sessions.listByFeatureAll:f1',
      'sessions.deleteByFeature:f1',
      'summaries.delete:f1',
      'worktrees.removeForFeature:f1',
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
    const { admin, calls } = harness([session('s1')], {
      withCaptureCleanup: true,
      withMetaUsageCleanup: true,
      withSessionSummaries: true,
      withOwnedAutomationCleanup: true,
      withOwnedSubagentCleanup: true,
    });
    await admin.deleteSession('s1');
    expect(calls).toEqual([
      'ownedAutomations.deleteBySession:s1',
      'ownedSubagents.deleteBySession:s1',
      'liveUsage.release:s1',
      'terminals.close:s1',
      'usageCaptures.deleteBySession:s1',
      'metaUsage.deleteBySession:s1',
      'usage.deleteBySession:s1',
      'sessionFiles.deleteBySession:s1',
      'sessionSummaries.delete:s1',
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

  it('deletes a session when no live-usage releaser is wired', async () => {
    const { admin, calls } = harness([session('s1')], {
      withoutLiveUsage: true,
    });
    await admin.deleteSession('s1');
    expect(calls).toEqual([
      'terminals.close:s1',
      'usage.deleteBySession:s1',
      'sessionFiles.deleteBySession:s1',
      'transcripts.delete:s1',
      'sessions.delete:s1',
    ]);
  });
});
