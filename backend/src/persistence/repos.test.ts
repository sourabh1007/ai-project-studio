import { describe, it, expect } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createFeatureRepo } from './feature-repo.js';
import { createSessionRepo } from './session-repo.js';
import { createUsageRepo } from './usage-repo.js';
import { createTranscriptRepo } from './transcript-repo.js';
import { createSummaryRepo } from './summary-repo.js';
import { createSessionSummaryRepo } from './session-summary-repo.js';
import { createSessionFilesRepo } from './session-files-repo.js';
import { createRepoRepo } from './repo-repo.js';
import { createFeatureGroupsRepo } from './feature-groups-repo.js';
import type { Feature } from '../feature/feature-contract.js';
import type { Repository } from '../repo/repo-contract.js';
import type { Session } from '../session/session-contract.js';
import type { TreeGroup } from '../feature-tree/feature-tree-contract.js';
import type { StoredUsage } from '../usage/usage-repo-port.js';

function treeGroup(overrides: Partial<TreeGroup> = {}): TreeGroup {
  return {
    id: 'g1',
    featureId: 'f1',
    parentGroupId: null,
    kind: 'subcategory',
    name: 'Docs',
    prNumber: null,
    prUrl: null,
    orderIndex: 0,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'f1',
    name: 'Login',
    description: 'Build login',
    createdAt: '2025-01-01T00:00:00.000Z',
    summary: null,
    repoId: null,
    checkoutPath: null,
    orderIndex: 0,
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    featureId: 'f1',
    name: null,
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'running',
    kind: 'dev',
    scope: 'feature',
    groupId: null,
    orderIndex: 0,
    prompt: 'do it',
    usageFilePath: 'usage/s1.jsonl',
    createdAt: '2025-01-01T00:00:00.000Z',
    startedAt: '2025-01-01T00:00:01.000Z',
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function usage(overrides: Partial<StoredUsage> = {}): StoredUsage {
  return {
    sessionId: 's1',
    featureId: 'f1',
    turnIndex: 0,
    kind: 'dev',
    provider: 'github',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5.4-mini',
    operation: 'chat',
    inputTokens: 100,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    cost: 0.33,
    credits: 0.33,
    nanoAiu: 1167825000,
    serviceRequestId: 'req-1',
    startedAt: '2025-01-01T00:00:02.000Z',
    endedAt: '2025-01-01T00:00:03.000Z',
    ...overrides,
  };
}

function repository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 'r1',
    provider: 'github',
    remoteUrl: 'https://github.com/acme/app.git',
    name: 'acme/app',
    localPath: 'C:/work/app',
    defaultBranch: 'main',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('feature-repo', () => {
  it('creates, reads, lists and sets summary', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createFeatureRepo(db);
    expect(repo.get('missing')).toBeNull();
    repo.create(feature());
    repo.create(feature({ id: 'f2', name: 'Search', createdAt: '2025-01-02T00:00:00.000Z' }));
    expect(repo.get('f1')).toEqual(feature());
    expect(repo.list().map((f) => f.id)).toEqual(['f1', 'f2']);
    repo.setSummary('f1', 'A summary');
    expect(repo.get('f1')?.summary).toBe('A summary');
    db.close();
  });

  it('renames and deletes a feature', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createFeatureRepo(db);
    repo.create(feature());
    repo.rename('f1', 'Sign in');
    expect(repo.get('f1')?.name).toBe('Sign in');
    repo.delete('f1');
    expect(repo.get('f1')).toBeNull();
    db.close();
  });

  it('round-trips a repository scope on a feature', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createFeatureRepo(db);
    repo.create(feature({ id: 'f1', repoId: 'repo-7' }));
    expect(repo.get('f1')?.repoId).toBe('repo-7');
    db.close();
  });

  it('round-trips a checkout path override on a feature', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createFeatureRepo(db);
    repo.create(feature({ id: 'f1', checkoutPath: 'C:/wt/app-pr-3' }));
    expect(repo.get('f1')?.checkoutPath).toBe('C:/wt/app-pr-3');
    db.close();
  });

  it('re-homes a feature to a repository group and sort position', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createFeatureRepo(db);
    repo.create(feature({ id: 'f1' }));
    repo.updatePlacement('f1', { repoId: 'repo-7', orderIndex: 3 });
    const moved = repo.get('f1');
    expect(moved?.repoId).toBe('repo-7');
    expect(moved?.orderIndex).toBe(3);
    repo.updatePlacement('f1', { repoId: null, orderIndex: 0 });
    expect(repo.get('f1')?.repoId).toBeNull();
    db.close();
  });

  it('defaults order_index to 0 when a feature omits it on create', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createFeatureRepo(db);
    repo.create(feature({ id: 'f1', orderIndex: undefined }));
    expect(repo.get('f1')?.orderIndex).toBe(0);
    db.close();
  });

  it('orders features by order_index then creation time', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createFeatureRepo(db);
    repo.create(
      feature({ id: 'f1', createdAt: '2025-01-01T00:00:00.000Z', orderIndex: 2 }),
    );
    repo.create(
      feature({ id: 'f2', createdAt: '2025-01-02T00:00:00.000Z', orderIndex: 1 }),
    );
    expect(repo.list().map((f) => f.id)).toEqual(['f2', 'f1']);
    db.close();
  });
});

describe('session-repo', () => {
  it('upserts, reads and lists by feature', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSessionRepo(db);
    expect(repo.get('missing')).toBeNull();
    repo.save(session());
    expect(repo.get('s1')).toEqual(session());
    repo.save(session({ status: 'completed', resolvedModel: 'gpt-5.4-mini', endedAt: '2025-01-01T00:00:05.000Z', exitCode: 0 }));
    expect(repo.get('s1')?.status).toBe('completed');
    expect(repo.get('s1')?.exitCode).toBe(0);
    repo.save(session({ id: 's2' }));
    expect(repo.listByFeature('f1').map((s) => s.id)).toEqual(['s1', 's2']);
    repo.save(session({ id: 's3', featureId: 'f2' }));
    expect(repo.listAll().map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    db.close();
  });

  it('normalizes undefined/non-finite nullable fields to null when saving', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSessionRepo(db);
    // A PTY exit can hand back `undefined` for exitCode and unset timestamps at
    // runtime even though the type says `number | null`; these must not crash
    // the SQLite bind and should round-trip as null.
    repo.save(
      session({
        resolvedModel: undefined as unknown as string | null,
        startedAt: undefined as unknown as string | null,
        endedAt: undefined as unknown as string | null,
        exitCode: undefined as unknown as number | null,
        orderIndex: undefined as unknown as number,
      }),
    );
    const saved = repo.get('s1');
    expect(saved?.resolvedModel).toBeNull();
    expect(saved?.startedAt).toBeNull();
    expect(saved?.endedAt).toBeNull();
    expect(saved?.exitCode).toBeNull();
    expect(saved?.orderIndex).toBe(0);

    repo.save(session({ exitCode: Number.NaN }));
    expect(repo.get('s1')?.exitCode).toBeNull();
    repo.save(session({ exitCode: 2.9 }));
    expect(repo.get('s1')?.exitCode).toBe(2);
    db.close();
  });

  it('deletes a single session and all sessions for a feature', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSessionRepo(db);
    repo.save(session());
    repo.save(session({ id: 's2' }));
    repo.save(session({ id: 's3', featureId: 'f2' }));
    repo.delete('s1');
    expect(repo.get('s1')).toBeNull();
    repo.deleteByFeature('f1');
    expect(repo.listByFeature('f1')).toEqual([]);
    expect(repo.get('s3')).not.toBeNull();
    db.close();
  });

  it('hides internal sessions from feature lists but retains them internally', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSessionRepo(db);
    repo.save(session({ id: 'visible' }));
    repo.save(session({ id: 'analysis', scope: 'internal', kind: 'meta' }));

    expect(repo.listByFeature('f1').map((s) => s.id)).toEqual(['visible']);
    expect(repo.listAll().map((s) => s.id)).toEqual(['analysis', 'visible']);
    expect(repo.get('analysis')?.scope).toBe('internal');
    db.close();
  });

  it('listByFeatureAll includes internal metasessions for analytics', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSessionRepo(db);
    repo.save(session({ id: 'visible' }));
    repo.save(session({ id: 'meta', scope: 'internal', kind: 'meta' }));
    repo.save(session({ id: 'other', featureId: 'f2', scope: 'internal', kind: 'meta' }));

    expect(repo.listByFeatureAll('f1').map((s) => s.id)).toEqual([
      'meta',
      'visible',
    ]);
    expect(repo.listByFeatureAll('f2').map((s) => s.id)).toEqual(['other']);
    db.close();
  });

  it('defaults a missing scope to "feature" on save', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSessionRepo(db);
    repo.save(session({ id: 'noscope', scope: undefined as unknown as Session['scope'] }));
    expect(repo.get('noscope')?.scope).toBe('feature');
    db.close();
  });

  it('persists a name on save and renames it in place', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSessionRepo(db);
    repo.save(session({ name: 'Auth spike' }));
    expect(repo.get('s1')?.name).toBe('Auth spike');
    repo.rename('s1', 'Login form');
    expect(repo.get('s1')?.name).toBe('Login form');
    repo.rename('s1', null);
    expect(repo.get('s1')?.name).toBeNull();
    db.close();
  });

  it('re-homes a session to a group and sets its sort position', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSessionRepo(db);
    repo.save(session());
    repo.updatePlacement('s1', { featureId: 'f2', groupId: 'g9', orderIndex: 3 });
    const moved = repo.get('s1');
    expect(moved?.featureId).toBe('f2');
    expect(moved?.groupId).toBe('g9');
    expect(moved?.orderIndex).toBe(3);
    repo.updatePlacement('s1', {
      featureId: 'f2',
      groupId: null,
      orderIndex: Number.NaN,
    });
    const detached = repo.get('s1');
    expect(detached?.groupId).toBeNull();
    expect(detached?.orderIndex).toBe(0);
    db.close();
  });
});

describe('feature-groups-repo', () => {
  it('upserts, reads and lists groups by feature', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createFeatureGroupsRepo(db);
    expect(repo.get('missing')).toBeNull();
    repo.save(treeGroup());
    expect(repo.get('g1')).toEqual(treeGroup());
    repo.save(treeGroup({ id: 'g2', featureId: 'f1', orderIndex: 1 }));
    repo.save(treeGroup({ id: 'g3', featureId: 'f2' }));
    expect(
      repo
        .listByFeature('f1')
        .map((g) => g.id)
        .sort(),
    ).toEqual(['g1', 'g2']);
    db.close();
  });

  it('round-trips pull-request metadata', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createFeatureGroupsRepo(db);
    repo.save(
      treeGroup({
        id: 'pr',
        kind: 'pr',
        name: 'PR #7',
        prNumber: 7,
        prUrl: 'https://example/pr/7',
      }),
    );
    const stored = repo.get('pr');
    expect(stored).toMatchObject({ kind: 'pr', prNumber: 7, prUrl: 'https://example/pr/7' });
    db.close();
  });

  it('renames and re-homes a group', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createFeatureGroupsRepo(db);
    repo.save(treeGroup());
    repo.updateName('g1', 'Renamed');
    expect(repo.get('g1')?.name).toBe('Renamed');
    repo.updatePlacement('g1', {
      featureId: 'f2',
      parentGroupId: 'p9',
      orderIndex: 4,
    });
    const moved = repo.get('g1');
    expect(moved?.featureId).toBe('f2');
    expect(moved?.parentGroupId).toBe('p9');
    expect(moved?.orderIndex).toBe(4);
    db.close();
  });

  it('deletes a single group and all groups for a feature', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createFeatureGroupsRepo(db);
    repo.save(treeGroup({ id: 'g1' }));
    repo.save(treeGroup({ id: 'g2' }));
    repo.save(treeGroup({ id: 'g3', featureId: 'f2' }));
    repo.delete('g1');
    expect(repo.get('g1')).toBeNull();
    repo.deleteByFeature('f1');
    expect(repo.listByFeature('f1')).toEqual([]);
    expect(repo.get('g3')).not.toBeNull();
    db.close();
  });
});

describe('usage-repo', () => {
  it('saves and lists usage events ordered by turn', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createUsageRepo(db);
    repo.saveAll([usage({ turnIndex: 1 }), usage({ turnIndex: 0 })]);
    const rows = repo.listBySession('s1');
    expect(rows.map((r) => r.turnIndex)).toEqual([0, 1]);
    expect(rows[0]).toEqual(usage({ turnIndex: 0 }));
    db.close();
  });

  it('deletes usage events for a session', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createUsageRepo(db);
    repo.saveAll([usage({ turnIndex: 0 }), usage({ sessionId: 's2', turnIndex: 0 })]);
    repo.deleteBySession('s1');
    expect(repo.listBySession('s1')).toEqual([]);
    expect(repo.listBySession('s2')).toHaveLength(1);
    db.close();
  });
});

describe('summary-repo', () => {
  it('saves, overwrites and loads a feature summary, null when absent', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSummaryRepo(db);
    expect(repo.load('f1')).toBeNull();
    repo.save({ featureId: 'f1', content: 'first', createdAt: '2025-01-01T00:00:00.000Z' });
    expect(repo.load('f1')).toEqual({
      featureId: 'f1',
      content: 'first',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    repo.save({ featureId: 'f1', content: 'second', createdAt: '2025-01-02T00:00:00.000Z' });
    expect(repo.load('f1')?.content).toBe('second');
    db.close();
  });

  it('deletes a feature summary', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSummaryRepo(db);
    repo.save({ featureId: 'f1', content: 'x', createdAt: '2025-01-01T00:00:00.000Z' });
    repo.delete('f1');
    expect(repo.load('f1')).toBeNull();
    db.close();
  });
});

describe('session-summary-repo', () => {
  it('saves, overwrites and loads a session summary, null when absent', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSessionSummaryRepo(db);
    expect(repo.load('s1')).toBeNull();
    repo.save({ sessionId: 's1', content: 'first', createdAt: '2025-01-01T00:00:00.000Z' });
    expect(repo.load('s1')).toEqual({
      sessionId: 's1',
      content: 'first',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    repo.save({ sessionId: 's1', content: 'second', createdAt: '2025-01-02T00:00:00.000Z' });
    expect(repo.load('s1')?.content).toBe('second');
    db.close();
  });

  it('deletes a session summary', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSessionSummaryRepo(db);
    repo.save({ sessionId: 's1', content: 'x', createdAt: '2025-01-01T00:00:00.000Z' });
    repo.delete('s1');
    expect(repo.load('s1')).toBeNull();
    db.close();
  });
});

describe('session-files-repo', () => {
  it('records, upgrades edit to create, keeps earliest time, lists newest first', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSessionFilesRepo(db);
    expect(repo.list('s1')).toEqual([]);

    repo.record('s1', 'C:\\proj\\a.ts', 'edit', '2025-01-01T00:00:01.000Z');
    repo.record('s1', 'C:\\proj\\sub\\b.ts', 'create', '2025-01-01T00:00:03.000Z');
    // A second sighting of a.ts as a create upgrades the tool but keeps the
    // earliest first-seen timestamp.
    repo.record('s1', 'C:\\proj\\a.ts', 'create', '2025-01-01T00:00:05.000Z');
    // A later edit does not downgrade an existing create.
    repo.record('s1', 'C:\\proj\\sub\\b.ts', 'edit', '2025-01-01T00:00:07.000Z');

    const files = repo.list('s1');
    expect(files).toEqual([
      {
        path: 'C:\\proj\\sub\\b.ts',
        name: 'b.ts',
        dir: 'C:\\proj\\sub',
        tool: 'create',
        firstSeenAt: '2025-01-01T00:00:03.000Z',
      },
      {
        path: 'C:\\proj\\a.ts',
        name: 'a.ts',
        dir: 'C:\\proj',
        tool: 'create',
        firstSeenAt: '2025-01-01T00:00:01.000Z',
      },
    ]);
    db.close();
  });

  it('splits posix paths and handles a bare filename with no directory', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSessionFilesRepo(db);
    repo.record('s1', '/home/u/notes.md', 'edit', '2025-01-01T00:00:01.000Z');
    repo.record('s1', 'top.txt', 'edit', '2025-01-01T00:00:02.000Z');
    const files = repo.list('s1');
    expect(files.find((f) => f.path === '/home/u/notes.md')).toMatchObject({
      name: 'notes.md',
      dir: '/home/u',
    });
    expect(files.find((f) => f.path === 'top.txt')).toMatchObject({
      name: 'top.txt',
      dir: '',
    });
    db.close();
  });

  it('deletes all files for a session without touching others', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSessionFilesRepo(db);
    repo.record('s1', 'C:\\a.ts', 'edit', '2025-01-01T00:00:01.000Z');
    repo.record('s2', 'C:\\b.ts', 'edit', '2025-01-01T00:00:02.000Z');
    repo.deleteBySession('s1');
    expect(repo.list('s1')).toEqual([]);
    expect(repo.list('s2')).toHaveLength(1);
    db.close();
  });
});

describe('transcript-repo', () => {
  it('saves and loads transcripts, returns null when absent', async () => {    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createTranscriptRepo(db);
    expect(await repo.load('s1')).toBeNull();
    await repo.save({ sessionId: 's1', stdout: ['a', 'b'], stderr: ['e'], exitCode: 0 });
    expect(await repo.load('s1')).toEqual({
      sessionId: 's1',
      stdout: ['a', 'b'],
      stderr: ['e'],
      exitCode: 0,
    });
    db.close();
  });

  it('deletes a transcript', async () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createTranscriptRepo(db);
    await repo.save({ sessionId: 's1', stdout: ['a'], stderr: [], exitCode: 0 });
    await repo.delete('s1');
    expect(await repo.load('s1')).toBeNull();
    db.close();
  });
});

describe('repo-repo', () => {
  it('creates, reads, lists and deletes repositories', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createRepoRepo(db);
    expect(repo.get('missing')).toBeNull();
    repo.create(repository());
    repo.create(
      repository({
        id: 'r2',
        provider: 'azure-devops',
        name: 'proj/api',
        defaultBranch: null,
        createdAt: '2025-01-02T00:00:00.000Z',
      }),
    );
    expect(repo.get('r1')).toEqual(repository());
    expect(repo.get('r2')?.provider).toBe('azure-devops');
    expect(repo.get('r2')?.defaultBranch).toBeNull();
    expect(repo.list().map((r) => r.id)).toEqual(['r1', 'r2']);
    repo.delete('r1');
    expect(repo.get('r1')).toBeNull();
    db.close();
  });
});
