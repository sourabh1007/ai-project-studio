import { describe, expect, it } from 'vitest';
import type {
  PrReview,
  PrReviewStepStatus,
} from '../pr-review/pr-review-contract.js';
import { createDatabase } from './db/connection.js';
import { createPrReviewRepo } from './pr-review-repo.js';

function baseStep(status: PrReviewStepStatus) {
  return {
    status,
    metaSessionId: status === 'ready' ? 'meta-1' : null,
    usage: null,
    failure:
      status === 'failed'
        ? { message: 'boom', failedAt: '2026-08-01T00:02:00.000Z' }
        : null,
    activity: status === 'ready' ? ['💬 done'] : [],
    generatedAt: status === 'ready' ? '2026-08-01T00:01:00.000Z' : null,
  };
}

function review(overrides: Partial<PrReview> = {}): PrReview {
  return {
    featureId: 'f1',
    repoId: 'r1',
    pull: { number: 7, title: 'Add retry', url: 'https://example.com/pr/7' },
    worktreePath: 'C:\\work\\pr-7',
    baseBranch: 'main',
    description: 'Requests fail transiently.',
    problemStatement: {
      ...baseStep('ready'),
      content: 'Requests fail transiently.',
      sufficient: true,
    },
    changeGraph: {
      ...baseStep('ready'),
      projects: [{ id: 'src/App.csproj', name: 'App', path: 'src/App.csproj' }],
      nodes: [
        {
          path: 'src/A.cs',
          projectId: 'src/App.csproj',
          module: 'App',
          category: 'code',
          kind: 'changed',
          changeKind: 'modified',
          diff: '@@ -1 +1 @@',
          whatItDoes: 'Runs a.',
          whatChanged: 'Adds retry.',
          review: [],
        },
      ],
      edges: [],
    },
    changedFiles: 3,
    timestamps: {
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
    },
    ...overrides,
  };
}

describe('pr-review-repo', () => {
  it('saves, loads and deletes a ready review', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const reviews = createPrReviewRepo(db);

    expect(reviews.get('missing')).toBeNull();
    reviews.save(review());
    expect(reviews.get('f1')).toEqual(review());

    reviews.delete('f1');
    expect(reviews.get('f1')).toBeNull();
  });

  it('finds an existing review feature by repo and pull number', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const reviews = createPrReviewRepo(db);

    expect(reviews.findFeatureByPull('r1', 7)).toBeNull();
    reviews.save(review());
    expect(reviews.findFeatureByPull('r1', 7)).toBe('f1');
    expect(reviews.findFeatureByPull('r1', 99)).toBeNull();
    expect(reviews.findFeatureByPull('other', 7)).toBeNull();
  });

  it('round-trips reviews across every overall status', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const reviews = createPrReviewRepo(db);

    const generating = review({
      problemStatement: {
        ...baseStep('generating'),
        content: null,
        sufficient: true,
      },
      changeGraph: {
        ...baseStep('pending'),
        projects: [],
        nodes: [],
        edges: [],
      },
      baseBranch: null,
      changedFiles: null,
    });
    reviews.save(generating);
    expect(reviews.get('f1')).toEqual(generating);

    const failed = review({
      changeGraph: { ...baseStep('failed'), projects: [], nodes: [], edges: [] },
    });
    reviews.save(failed);
    expect(reviews.get('f1')).toEqual(failed);

    const pending = review({
      problemStatement: {
        ...baseStep('pending'),
        content: null,
        sufficient: true,
      },
      changeGraph: { ...baseStep('pending'), projects: [], nodes: [], edges: [] },
    });
    reviews.save(pending);
    expect(reviews.get('f1')).toEqual(pending);
  });

  it('lists all persisted reviews and excludes legacy document-less rows', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const reviews = createPrReviewRepo(db);

    expect(reviews.listAll()).toEqual([]);

    reviews.save(review());
    reviews.save(
      review({
        featureId: 'f2',
        pull: { number: 8, title: 'Second', url: 'https://example.com/pr/8' },
      }),
    );
    db.prepare(
      `INSERT INTO pr_reviews (
         feature_id, repo_id, pull_number, pull_title, pull_url, worktree_path,
         base_branch, status, changed_files, created_at, updated_at, document
       ) VALUES ('legacy', 'r1', 1, 't', 'u', 'w', 'main', 'ready', 0,
         '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL)`,
    ).run();

    const all = reviews.listAll();
    expect(all.map((r) => r.featureId).sort()).toEqual(['f1', 'f2']);
  });

  it('treats a legacy row with no document as absent', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const reviews = createPrReviewRepo(db);
    db.prepare(
      `INSERT INTO pr_reviews (
         feature_id, repo_id, pull_number, pull_title, pull_url, worktree_path,
         base_branch, status, changed_files, created_at, updated_at, document
       ) VALUES ('legacy', 'r1', 1, 't', 'u', 'w', 'main', 'ready', 0,
         '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL)`,
    ).run();
    expect(reviews.get('legacy')).toBeNull();
  });

  it('migrates a legacy single-summary document to a pending two-step review', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const reviews = createPrReviewRepo(db);
    const legacyDoc = JSON.stringify({
      repoId: 'r9',
      pull: { number: 42, title: 'Legacy PR', url: 'https://example.com/pr/42' },
      worktreePath: 'C:\\work\\pr-42',
      // baseBranch, description and changedFiles intentionally omitted so the
      // nullish fallbacks are exercised.
      summary: 'Old summary',
      coreAnalysis: 'Old analysis',
      timestamps: {
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:05:00.000Z',
      },
    });
    db.prepare(
      `INSERT INTO pr_reviews (
         feature_id, repo_id, pull_number, pull_title, pull_url, worktree_path,
         base_branch, status, changed_files, created_at, updated_at, document
       ) VALUES ('legacy2', 'r9', 42, 'Legacy PR', 'https://example.com/pr/42',
         'C:\\work\\pr-42', NULL, 'ready', NULL,
         '2026-07-01T00:00:00.000Z', '2026-07-01T00:05:00.000Z', ?)`,
    ).run(legacyDoc);

    expect(reviews.get('legacy2')).toEqual({
      featureId: 'legacy2',
      repoId: 'r9',
      pull: { number: 42, title: 'Legacy PR', url: 'https://example.com/pr/42' },
      worktreePath: 'C:\\work\\pr-42',
      baseBranch: null,
      description: null,
      problemStatement: {
        status: 'pending',
        metaSessionId: null,
        usage: null,
        failure: null,
        activity: [],
        generatedAt: null,
        content: null,
        sufficient: true,
      },
      changeGraph: {
        status: 'pending',
        metaSessionId: null,
        usage: null,
        failure: null,
        activity: [],
        generatedAt: null,
        projects: [],
        nodes: [],
        edges: [],
      },
      changedFiles: null,
      timestamps: {
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:05:00.000Z',
      },
    });
  });

  it('migrates a legacy four-step document to a pending two-step review', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const reviews = createPrReviewRepo(db);
    const legacyDoc = JSON.stringify({
      repoId: 'r9',
      pull: { number: 44, title: 'Four-step PR', url: 'https://example.com/pr/44' },
      worktreePath: 'C:\\work\\pr-44',
      baseBranch: 'release/1.0',
      description: 'A real description.',
      // The previous four-step shape lacks changeGraph, so it is re-run.
      problemStatement: { status: 'ready', content: 'x', sufficient: true },
      proposal: { status: 'ready', content: 'y' },
      syntacticReview: { status: 'ready', content: 'z' },
      changedFiles: 5,
      timestamps: {
        createdAt: '2026-07-02T00:00:00.000Z',
        updatedAt: '2026-07-02T00:05:00.000Z',
      },
    });
    db.prepare(
      `INSERT INTO pr_reviews (
         feature_id, repo_id, pull_number, pull_title, pull_url, worktree_path,
         base_branch, status, changed_files, created_at, updated_at, document
       ) VALUES ('legacy4', 'r9', 44, 'Four-step PR', 'https://example.com/pr/44',
         'C:\\work\\pr-44', 'release/1.0', 'ready', 5,
         '2026-07-02T00:00:00.000Z', '2026-07-02T00:05:00.000Z', ?)`,
    ).run(legacyDoc);

    const migrated = reviews.get('legacy4');
    expect(migrated?.baseBranch).toBe('release/1.0');
    expect(migrated?.description).toBe('A real description.');
    expect(migrated?.changedFiles).toBe(5);
    expect(migrated?.problemStatement.status).toBe('pending');
    expect(migrated?.changeGraph).toEqual({
      status: 'pending',
      metaSessionId: null,
      usage: null,
      failure: null,
      activity: [],
      generatedAt: null,
      projects: [],
      nodes: [],
      edges: [],
    });
  });

  it('back-fills a missing activity log on a persisted two-step review', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const reviews = createPrReviewRepo(db);
    const doc = JSON.stringify({
      repoId: 'r9',
      pull: { number: 45, title: 'No activity', url: 'https://example.com/pr/45' },
      worktreePath: 'C:\\work\\pr-45',
      baseBranch: 'main',
      description: null,
      // Both steps predate the activity log field.
      problemStatement: {
        status: 'ready',
        metaSessionId: 'm1',
        usage: null,
        failure: null,
        generatedAt: '2026-07-03T00:01:00.000Z',
        content: 'p',
        sufficient: true,
      },
      changeGraph: {
        status: 'ready',
        metaSessionId: 'm2',
        usage: null,
        failure: null,
        generatedAt: '2026-07-03T00:02:00.000Z',
        projects: [],
        nodes: [],
        edges: [],
      },
      changedFiles: 0,
      timestamps: {
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:02:00.000Z',
      },
    });
    db.prepare(
      `INSERT INTO pr_reviews (
         feature_id, repo_id, pull_number, pull_title, pull_url, worktree_path,
         base_branch, status, changed_files, created_at, updated_at, document
       ) VALUES ('noact', 'r9', 45, 'No activity', 'https://example.com/pr/45',
         'C:\\work\\pr-45', 'main', 'ready', 0,
         '2026-07-03T00:00:00.000Z', '2026-07-03T00:02:00.000Z', ?)`,
    ).run(doc);

    const migrated = reviews.get('noact');
    expect(migrated?.problemStatement.activity).toEqual([]);
    expect(migrated?.changeGraph.activity).toEqual([]);
  });

  it('resets a legacy modules/files change graph to a pending reference graph', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const reviews = createPrReviewRepo(db);
    const doc = JSON.stringify({
      repoId: 'r9',
      pull: { number: 46, title: 'Old graph', url: 'https://example.com/pr/46' },
      worktreePath: 'C:\\work\\pr-46',
      baseBranch: 'main',
      description: null,
      problemStatement: {
        status: 'ready',
        metaSessionId: 'm1',
        usage: null,
        failure: null,
        activity: [],
        generatedAt: '2026-07-04T00:01:00.000Z',
        content: 'p',
        sufficient: true,
      },
      // The pre-redesign change graph carried module hubs and file leaves.
      changeGraph: {
        status: 'ready',
        metaSessionId: 'm2',
        usage: null,
        failure: null,
        activity: ['💬 old'],
        generatedAt: '2026-07-04T00:02:00.000Z',
        modules: [{ id: 'core', name: 'Core', summary: 'Core.' }],
        files: [{ path: 'a.ts', moduleId: 'core', whatItDoes: 'x', whatChanged: 'y' }],
      },
      changedFiles: 1,
      timestamps: {
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:02:00.000Z',
      },
    });
    db.prepare(
      `INSERT INTO pr_reviews (
         feature_id, repo_id, pull_number, pull_title, pull_url, worktree_path,
         base_branch, status, changed_files, created_at, updated_at, document
       ) VALUES ('oldgraph', 'r9', 46, 'Old graph', 'https://example.com/pr/46',
         'C:\\work\\pr-46', 'main', 'ready', 1,
         '2026-07-04T00:00:00.000Z', '2026-07-04T00:02:00.000Z', ?)`,
    ).run(doc);

    const migrated = reviews.get('oldgraph');
    // The problem statement survives; only the stale graph is reset to pending.
    expect(migrated?.problemStatement.status).toBe('ready');
    expect(migrated?.changeGraph).toEqual({
      status: 'pending',
      metaSessionId: null,
      usage: null,
      failure: null,
      activity: [],
      generatedAt: null,
      projects: [],
      nodes: [],
      edges: [],
    });
  });
});
