import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createEventBus } from '../kernel/event-bus.js';
import { createClock } from '../kernel/clock.js';
import type { MetaRequest, MetaRunResult } from '../meta/meta-runner.js';
import { createMetaUsageReader } from '../pr-review/meta-usage-reader.js';
import { createPrApprovalService } from '../pr-review/pr-approval-service.js';
import type {
  PrCommentThread,
  PrCommentsGateway,
  PrCommentsGatewayResolver,
  PrCommentThreadStatus,
} from '../pr-review/pr-comments-contract.js';
import { createPrCommentsService } from '../pr-review/pr-comments-service.js';
import type {
  PrDescriptionGateway,
  PrDescriptionGatewayResolver,
} from '../pr-review/pr-description-contract.js';
import { createPrDescriptionService } from '../pr-review/pr-description-service.js';
import type {
  PrDiff,
  PrReviewEventMap,
  PrReviewRepo,
} from '../pr-review/pr-review-contract.js';
import { createPrReviewService } from '../pr-review/pr-review-service.js';
import { prReviewDefaults } from '../pr-review/config.js';
import { createCSharpAnalyzer } from '../pr-review/csharp-analyzer.js';
import type { ChangeGraphFs } from '../pr-review/change-graph-fs.js';
import { createLanguageAnalyzerRegistry } from '../pr-review/language-analyzer.js';
import { createReviewBoardService } from '../review-board/review-board-service.js';
import { reviewBoardDefaults } from '../review-board/config.js';
import { createPrFeatureService } from '../repo/pr-feature-service.js';
import type { ProvisionedWorktree } from '../repo/pr-worktree-provisioner.js';
import type { RemotePullRequest } from '../repo/remote-pr-contract.js';
import { createFeatureService } from '../feature/feature-service.js';
import { createIdGenerator } from '../kernel/id-generator.js';
import { createRepoService } from '../repo/repo-service.js';
import { createDatabase } from '../persistence/db/connection.js';
import { createFeatureRepo } from '../persistence/feature-repo.js';
import { createMetaUsageRepo } from '../persistence/meta-usage-repo.js';
import { createPrReviewRepo } from '../persistence/pr-review-repo.js';
import { createRepoRepo } from '../persistence/repo-repo.js';
import { createSessionFilesRepo } from '../persistence/session-files-repo.js';
import { createSessionRepo } from '../persistence/session-repo.js';
import { createSummaryRepo } from '../persistence/summary-repo.js';
import { createTranscriptRepo } from '../persistence/transcript-repo.js';
import { createUsageRepo } from '../persistence/usage-repo.js';
import { createWorkspaceAdmin } from '../workspace/workspace-admin-service.js';

const timestamp = '2026-09-10T06:30:00.000Z';

const pull: RemotePullRequest = {
  provider: 'github',
  number: 7,
  title: 'Make storage loading resilient',
  url: 'https://github.com/acme/app/pull/7',
  sourceBranch: 'feature/resilient-storage',
  targetBranch: 'release/1.2',
  author: 'octocat',
  body: 'Adds resilient service loading and test coverage for storage changes.',
};

const diff: PrDiff = {
  baseRef: 'origin/release/1.2',
  changedFiles: 4,
  files: [
    'src/Service.cs',
    'src/Store.cs',
    'tests/ServiceTests.cs',
    'config/appsettings.json',
  ],
  entries: [
    {
      path: 'src/Service.cs',
      status: 'modified',
      patch: '@@ -1 +1 @@\n-public class Service { }\n+public class Service { public Store Load() => new Store(); }',
    },
    {
      path: 'src/Store.cs',
      status: 'modified',
      patch: '@@ -1 +1 @@\n-public class Store { }\n+public class Store { }',
    },
    {
      path: 'tests/ServiceTests.cs',
      status: 'modified',
      patch: '@@ -1 +1 @@\n-public class ServiceTests { }\n+public class ServiceTests { public void Loads() { var service = new Service(); } }',
    },
    {
      path: 'config/appsettings.json',
      status: 'modified',
      patch: '@@ -1 +1 @@\n-{}\n+{\"Storage\":\"resilient\"}',
    },
  ],
  stat: '4 files changed',
  patch: 'diff --stat',
  truncated: false,
};

const worktreeFiles: Record<string, string> = {
  'src/Service.cs':
    'namespace App;\npublic class Service { public Store Load() => new Store(); }',
  'src/Store.cs': 'namespace App;\npublic class Store { }',
  'tests/ServiceTests.cs':
    'namespace App.Tests;\npublic class ServiceTests { public void Loads() { var service = new Service(); } }',
  'config/appsettings.json': '{"Storage":"resilient"}',
};

function fakeChangeGraphFs(): ChangeGraphFs {
  return {
    readFile: async (_worktreePath, path) => worktreeFiles[path] ?? null,
    listDir: async (_worktreePath, path) => {
      if (path === 'src') return ['App.csproj'];
      if (path === 'tests') return ['App.Tests.csproj'];
      return [];
    },
    listFilesRecursive: async () => [],
  };
}

async function waitForReview(
  reviews: { find(featureId: string): ReturnType<PrReviewRepo['get']> },
  featureId: string,
): Promise<NonNullable<ReturnType<PrReviewRepo['get']>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const review = reviews.find(featureId);
    if (
      review &&
      review.problemStatement.status === 'ready' &&
      review.changeGraph.status === 'ready'
    ) {
      return review;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Review did not become ready: ${featureId}`);
}

interface Harness {
  db: DatabaseSync;
  repo: ReturnType<typeof createRepoService>;
  features: ReturnType<typeof createFeatureService>;
  featureRepo: ReturnType<typeof createFeatureRepo>;
  reviews: ReturnType<typeof createPrReviewService>;
  reviewRepo: ReturnType<typeof createPrReviewRepo>;
  metaUsage: ReturnType<typeof createMetaUsageRepo>;
  prFeatures: ReturnType<typeof createPrFeatureService>;
  board: ReturnType<typeof createReviewBoardService>;
  boardRequests: MetaRequest[];
  boardSleeps: number[];
  provisioned: ProvisionedWorktree[];
  reviewRequests: MetaRequest[];
}

function createHarness(options: { boardFailures?: number } = {}): Harness {
  const db = createDatabase({ databasePath: ':memory:' });
  const repoRepo = createRepoRepo(db);
  const featureRepo = createFeatureRepo(db);
  const reviewRepo = createPrReviewRepo(db);
  const metaUsage = createMetaUsageRepo(db);
  const usage = createUsageRepo(db);
  const clock = createClock(() => Date.parse(timestamp));
  const repo = createRepoService({
    repo: repoRepo,
    ids: createIdGenerator(() => 'repo-1'),
    clock,
  });
  const features = createFeatureService({
    repo: featureRepo,
    ids: createIdGenerator(() => 'feature-1'),
    clock,
    repos: repo,
  });
  const reviewBus = createEventBus<PrReviewEventMap>();
  const reviewRequests: MetaRequest[] = [];
  const boardRequests: MetaRequest[] = [];
  const boardSleeps: number[] = [];
  let reviewRun = 0;
  let boardRun = 0;
  let remainingBoardFailures = options.boardFailures ?? 0;
  const ai = {
    async runDetailed(request: MetaRequest): Promise<MetaRunResult> {
      if (request.label === 'Review board') {
        boardRequests.push(request);
        if (remainingBoardFailures > 0) {
          remainingBoardFailures -= 1;
          throw new Error('warm review session unavailable');
        }
        boardRun += 1;
        return {
          text: '```json\n[]\n```',
          sessionId: `board-${boardRun}`,
        };
      }

      reviewRequests.push(request);
      reviewRun += 1;
      const sessionId = `review-${reviewRun}`;
      request.onStart?.(sessionId);
      request.onActivity?.('Reading pull request description');
      metaUsage.save({
        sessionId,
        featureId: request.featureId,
        providerId: 'fake-provider',
        requestedModel: 'fake-model',
        resolvedModel: 'fake-model',
        transport: 'warm-acp',
        providerSessionId: `provider-${sessionId}`,
        purpose: 'pr-review',
        label: request.label ?? null,
        inputTokens: 120,
        outputTokens: 45,
        nanoAiu: 3_000_000_000,
        credits: 0.25,
        capturedAt: timestamp,
      });
      return {
        text: '## Problem Statement\nStorage reads need resilient retry behavior.',
        sessionId,
        transport: 'warm-acp',
      };
    },
  };
  const reviews = createPrReviewService({
    reviews: reviewRepo,
    diffs: { collect: async () => diff },
    ai,
    metaUsage: createMetaUsageReader({ usage, warmUsage: metaUsage }),
    temporaryPrompts: {
      create: async () => ({
        path: 'C:\\temp\\review-prompt.txt',
        cleanup: async () => {},
      }),
    },
    analyzers: createLanguageAnalyzerRegistry([createCSharpAnalyzer()]),
    changeGraphFs: fakeChangeGraphFs(),
    clock,
    sleep: async () => {},
    bus: reviewBus,
    config: prReviewDefaults,
    inlinePrompts: true,
  });

  const provisioned: ProvisionedWorktree[] = [];
  const currentPull = { ...pull };
  const prFeatures = createPrFeatureService({
    repos: repo,
    listPulls: async () => [currentPull],
    getPull: async () => currentPull,
    provisionWorktree: async () => {
      const worktree = {
        worktreePath: 'C:\\work\\app-pr-7',
        branch: currentPull.sourceBranch,
        headSha: `head-${provisioned.length + 1}`,
        tracksPullRequest: true,
      };
      provisioned.push(worktree);
      return worktree;
    },
    features,
    reviews,
  });

  const board = createReviewBoardService({
    reviews: { get: (featureId) => reviews.get(featureId) },
    config: reviewBoardDefaults,
    clock,
    ai,
    bus: { emit: () => {} },
    temporaryPrompts: {
      create: async () => ({
        path: 'C:\\temp\\board-prompt.txt',
        cleanup: async () => {},
      }),
    },
    sleep: async (ms) => {
      boardSleeps.push(ms);
    },
    inlinePrompts: true,
  });

  return {
    db,
    repo,
    features,
    featureRepo,
    reviews,
    reviewRepo,
    metaUsage,
    prFeatures,
    board,
    boardRequests,
    boardSleeps,
    provisioned,
    reviewRequests,
  };
}

describe('PR review vertical journey', () => {
  let db: DatabaseSync | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('creates and refreshes a persisted PR review, composes provider-neutral actions, and cleans up', async () => {
    const h = createHarness();
    db = h.db;
    const repository = h.repo.create({
      provider: 'github',
      remoteUrl: 'https://github.com/acme/app.git',
      name: 'acme/app',
      localPath: 'C:\\work\\app',
      defaultBranch: 'main',
    });

    const feature = await h.prFeatures.createFromPull(repository.id, pull.number);
    expect(feature).toMatchObject({
      id: 'feature-1',
      name: 'PR #7: Make storage loading resilient',
      repoId: repository.id,
      checkoutPath: 'C:\\work\\app-pr-7',
    });
    expect(h.provisioned).toHaveLength(1);

    const review = await waitForReview(h.reviews, feature.id);
    expect(review).toMatchObject({
      repoId: repository.id,
      pull: { number: 7, title: pull.title },
      headSha: 'head-1',
      baseBranch: 'release/1.2',
      description: pull.body,
      problemStatement: {
        status: 'ready',
        content: 'Storage reads need resilient retry behavior.',
        metaSessionId: 'review-1',
        usage: {
          inputTokens: 120,
          outputTokens: 45,
          credits: 0.25,
        },
      },
      changeGraph: { status: 'ready' },
      changedFiles: 4,
    });
    expect(review.changeGraph.nodes.map((node) => node.path)).toEqual(
      diff.files,
    );
    expect(review.changeGraph.edges).toHaveLength(1);
    expect(review.changeGraph.edges[0]).toMatchObject({
      from: 'src/Service.cs',
      to: 'src/Store.cs',
      calls: expect.arrayContaining([
        { symbol: 'Store', caller: null },
        { symbol: 'Store', caller: 'Load' },
      ]),
    });

    const stored = createPrReviewRepo(h.db).get(feature.id);
    expect(stored?.changeGraph.edges).toEqual(review.changeGraph.edges);
    expect(
      h.db
        .prepare('SELECT document FROM content.pr_reviews WHERE feature_id = ?')
        .get(feature.id),
    ).toMatchObject({ document: expect.stringContaining('"changeGraph"') });
    expect(h.metaUsage.get('review-1')).toMatchObject({
      featureId: feature.id,
      inputTokens: 120,
      credits: 0.25,
    });

    const sameFeature = await h.prFeatures.createFromPull(
      repository.id,
      pull.number,
    );
    expect(sameFeature.id).toBe(feature.id);
    expect(h.provisioned).toHaveLength(1);

    const commentState: { thread: PrCommentThread; body: string } = {
      thread: {
        id: 'thread-1',
        path: 'src/Service.cs',
        line: 1,
        status: 'active',
        comments: [],
      },
      body: 'Original PR description',
    };
    const commentGateway: PrCommentsGateway = {
      list: async () => [commentState.thread],
      add: async (input) => {
        commentState.thread = {
          ...commentState.thread,
          comments: [
            {
              id: 'comment-1',
              author: 'reviewer',
              body: input.body,
              createdAt: timestamp,
            },
          ],
        };
        return commentState.thread;
      },
      setStatus: async (
        threadId: string,
        status: PrCommentThreadStatus,
      ) => {
        expect(threadId).toBe('thread-1');
        commentState.thread = { ...commentState.thread, status };
        return commentState.thread;
      },
    };
    const commentsResolver: PrCommentsGatewayResolver = {
      resolve: () => commentGateway,
    };
    const comments = createPrCommentsService({
      reviews: { get: (id) => h.reviews.find(id) },
      repos: { get: (id) => h.repo.get(id) },
      gateways: commentsResolver,
    });
    expect(await comments.add(feature.id, {
      path: 'src/Service.cs',
      line: 1,
      body: 'Please preserve the retry boundary.',
    })).toMatchObject({ id: 'thread-1', comments: [{ id: 'comment-1' }] });
    expect(await comments.list(feature.id)).toHaveLength(1);
    expect(await comments.setStatus(feature.id, 'thread-1', 'resolved')).toMatchObject({
      status: 'resolved',
    });

    let approvalCalls = 0;
    const approval = createPrApprovalService({
      reviews: { get: (id) => h.reviews.find(id) },
      repos: { get: (id) => h.repo.get(id) },
      gateways: {
        resolve: () => ({
          approve: async () => {
            approvalCalls += 1;
            return { approved: true, state: 'approved', reviewer: 'reviewer' };
          },
        }),
      },
    });
    await expect(approval.approve(feature.id)).resolves.toEqual({
      approved: true,
      state: 'approved',
      reviewer: 'reviewer',
    });
    expect(approvalCalls).toBe(1);

    const descriptionGateway: PrDescriptionGateway = {
      getBody: async () => commentState.body,
      setBody: async (body) => {
        commentState.body = body;
      },
    };
    const descriptionResolver: PrDescriptionGatewayResolver = {
      resolve: () => descriptionGateway,
    };
    const description = createPrDescriptionService({
      reviews: { get: (id) => h.reviews.find(id) },
      repos: { get: (id) => h.repo.get(id) },
      gateways: descriptionResolver,
    });
    await description.exportToPull(feature.id);
    await description.exportToPull(feature.id);
    expect(commentState.body).toContain('Original PR description');
    expect(commentState.body.match(/ai-project-studio:pr-review:start/g)).toHaveLength(1);

    const latest = await h.prFeatures.pullLatest(feature.id);
    expect(latest.headSha).toBe('head-2');
    expect(latest.problemStatement.status).toBe('pending');
    const refreshed = await waitForReview(h.reviews, feature.id);
    expect(refreshed.headSha).toBe('head-2');
    expect(refreshed.problemStatement.metaSessionId).toBe('review-2');
    expect(h.provisioned).toHaveLength(2);

    const admin = createWorkspaceAdmin({
      features: h.features,
      sessions: createSessionRepo(h.db),
      quiescence: { feature: async () => {}, session: async () => {} },
      usage: createUsageRepo(h.db),
      metaUsage: h.metaUsage,
      transcripts: createTranscriptRepo(h.db),
      summaries: createSummaryRepo(h.db),
      sessionFiles: createSessionFilesRepo(h.db),
      terminals: { close: () => {} },
      prReviews: h.reviews,
      worktrees: { removeForFeature: async () => {} },
    });
    await admin.deleteFeature(feature.id);
    expect(h.featureRepo.get(feature.id)).toBeNull();
    expect(h.reviewRepo.get(feature.id)).toBeNull();
    expect(h.metaUsage.get('review-1')).toBeNull();
    expect(h.metaUsage.get('review-2')).toBeNull();
  });

  it('analyzes multiple board perspectives and forces the final retry cold', async () => {
    const h = createHarness({ boardFailures: 2 });
    db = h.db;
    const repository = h.repo.create({
      provider: 'github',
      remoteUrl: 'https://github.com/acme/app.git',
      name: 'acme/app',
      localPath: 'C:\\work\\app',
      defaultBranch: 'main',
    });
    const feature = await h.prFeatures.createFromPull(repository.id, pull.number);
    await waitForReview(h.reviews, feature.id);

    const initial = h.board.get(feature.id);
    expect(initial.model.perspectives.map((perspective) => perspective.id)).toEqual(
      expect.arrayContaining([
        'problem-solution',
        'testing',
        'configuration',
        'impact-blast-radius',
      ]),
    );

    const analyzed = await h.board.analyze(feature.id);
    expect(analyzed.perspectives.length).toBeGreaterThanOrEqual(4);
    expect(analyzed.summary.open).toBeGreaterThan(0);
    expect(analyzed.recommendation).toBe('request-changes');
    expect(h.boardRequests).toHaveLength(3);
    expect(h.boardRequests.slice(0, 2).every((request) => !request.forceCold)).toBe(
      true,
    );
    expect(h.boardRequests[2]?.forceCold).toBe(true);
    expect(h.boardSleeps).toEqual([
      reviewBoardDefaults.transientRetryBackoffMs,
      reviewBoardDefaults.transientRetryBackoffMs,
    ]);
  });
});
