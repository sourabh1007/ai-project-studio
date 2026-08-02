import { describe, expect, it } from 'vitest';
import type { RepositoryContext } from '../repository-context/repository-context-contract.js';
import { createDatabase } from './db/connection.js';
import { createRepoRepo } from './repo-repo.js';
import { createRepositoryContextRepo } from './repository-context-repo.js';

function context(
  overrides: Partial<RepositoryContext> = {},
): RepositoryContext {
  return {
    repositoryId: 'r1',
    status: 'ready',
    content: 'Repository summary',
    sourceRevision: 'abc123',
    timestamps: {
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
      generationStartedAt: '2026-08-01T00:00:10.000Z',
      generatedAt: '2026-08-01T00:01:00.000Z',
    },
    steps: [],
    failure: null,
    ...overrides,
  };
}

function addRepository(
  repo: ReturnType<typeof createRepoRepo>,
  id: string,
  createdAt = '2026-08-01T00:00:00.000Z',
): void {
  repo.create({
    id,
    provider: 'github',
    remoteUrl: `https://github.com/acme/${id}.git`,
    name: `acme/${id}`,
    localPath: `C:\\work\\${id}`,
    defaultBranch: 'main',
    createdAt,
  });
}

describe('repository-context-repo', () => {
  it('upserts, loads and lists complete lifecycle state', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repositories = createRepoRepo(db);
    const contexts = createRepositoryContextRepo(db);
    addRepository(repositories, 'r1');
    addRepository(repositories, 'r2', '2026-08-02T00:00:00.000Z');

    expect(contexts.get('missing')).toBeNull();
    contexts.save(context());
    contexts.save(
      context({
        repositoryId: 'r2',
        status: 'pending',
        content: null,
        sourceRevision: null,
        timestamps: {
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
          generationStartedAt: null,
          generatedAt: null,
        },
      }),
    );

    expect(contexts.get('r1')).toEqual(context());
    expect(contexts.list().map((item) => item.repositoryId)).toEqual(['r1', 'r2']);

    const generating = context({
      status: 'generating',
      content: null,
      sourceRevision: null,
      timestamps: {
        createdAt: 'ignored-on-upsert',
        updatedAt: '2026-08-01T00:02:00.000Z',
        generationStartedAt: '2026-08-01T00:02:00.000Z',
        generatedAt: null,
      },
    });
    contexts.save(generating);
    expect(contexts.get('r1')).toEqual({
      ...generating,
      content: 'Repository summary',
      sourceRevision: 'abc123',
      timestamps: {
        ...generating.timestamps,
        createdAt: '2026-08-01T00:00:00.000Z',
        generatedAt: '2026-08-01T00:01:00.000Z',
      },
    });
    db.close();
  });

  it('retains the last successful context when a refresh fails', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repositories = createRepoRepo(db);
    const contexts = createRepositoryContextRepo(db);
    addRepository(repositories, 'r1');
    contexts.save(context());

    contexts.save(
      context({
        status: 'failed',
        content: null,
        sourceRevision: null,
        timestamps: {
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:03:00.000Z',
          generationStartedAt: '2026-08-01T00:02:00.000Z',
          generatedAt: null,
        },
        failure: {
          code: 'generation_failed',
          message: 'Provider unavailable',
          failedAt: '2026-08-01T00:03:00.000Z',
          retryable: true,
          step: 'analyze',
        },
      }),
    );

    expect(contexts.get('r1')).toEqual(
      context({
        status: 'failed',
        timestamps: {
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:03:00.000Z',
          generationStartedAt: '2026-08-01T00:02:00.000Z',
          generatedAt: '2026-08-01T00:01:00.000Z',
        },
        failure: {
          code: 'generation_failed',
          message: 'Provider unavailable',
          failedAt: '2026-08-01T00:03:00.000Z',
          retryable: true,
          step: 'analyze',
        },
      }),
    );
    db.close();
  });

  it('deletes directly and cascades when its repository is deleted', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repositories = createRepoRepo(db);
    const contexts = createRepositoryContextRepo(db);
    addRepository(repositories, 'r1');
    addRepository(repositories, 'r2');
    contexts.save(context());
    contexts.save(context({ repositoryId: 'r2' }));

    contexts.delete('r1');
    expect(contexts.get('r1')).toBeNull();
    repositories.delete('r2');
    expect(contexts.get('r2')).toBeNull();
    db.close();
  });

  it('round-trips a non-retryable failure without prior content', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repositories = createRepoRepo(db);
    const contexts = createRepositoryContextRepo(db);
    addRepository(repositories, 'r1');
    const failed = context({
      status: 'failed',
      content: null,
      sourceRevision: null,
      timestamps: {
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:01:00.000Z',
        generationStartedAt: '2026-08-01T00:00:10.000Z',
        generatedAt: null,
      },
      failure: {
        code: 'invalid_output',
        message: 'Empty response',
        failedAt: '2026-08-01T00:01:00.000Z',
        retryable: false,
        step: 'analyze',
      },
    });
    contexts.save(failed);
    expect(contexts.get('r1')).toEqual(failed);
    db.close();
  });

  it('round-trips per-step progress and the failing step', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repositories = createRepoRepo(db);
    const contexts = createRepositoryContextRepo(db);
    addRepository(repositories, 'r1');
    const tracked = context({
      status: 'failed',
      content: null,
      sourceRevision: null,
      steps: [
        {
          key: 'collect-evidence',
          label: 'Collect repository evidence',
          status: 'ok',
          detail: '42 files',
          startedAt: '2026-08-01T00:00:10.000Z',
          finishedAt: '2026-08-01T00:00:11.000Z',
        },
        {
          key: 'analyze',
          label: 'Analyze repository with AI',
          status: 'failed',
          detail: 'attachment not supported',
          startedAt: '2026-08-01T00:00:11.000Z',
          finishedAt: '2026-08-01T00:00:12.000Z',
        },
        {
          key: 'persist',
          label: 'Store repository context',
          status: 'skipped',
          detail: null,
          startedAt: null,
          finishedAt: null,
        },
      ],
      failure: {
        code: 'generation_failed',
        message: 'attachment not supported',
        failedAt: '2026-08-01T00:00:12.000Z',
        retryable: true,
        step: 'analyze',
      },
    });
    contexts.save(tracked);
    expect(contexts.get('r1')).toEqual(tracked);
    db.close();
  });

  it('defaults steps to an empty list for blank or malformed values', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repositories = createRepoRepo(db);
    const contexts = createRepositoryContextRepo(db);
    addRepository(repositories, 'r1');
    contexts.save(context());
    db.exec("UPDATE repository_contexts SET steps = '' WHERE repo_id = 'r1'");
    expect(contexts.get('r1')?.steps).toEqual([]);
    db.exec("UPDATE repository_contexts SET steps = 'not-json' WHERE repo_id = 'r1'");
    expect(contexts.get('r1')?.steps).toEqual([]);
    db.exec("UPDATE repository_contexts SET steps = '{}' WHERE repo_id = 'r1'");
    expect(contexts.get('r1')?.steps).toEqual([]);
    db.close();
  });
});
