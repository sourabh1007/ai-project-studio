import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewBoard } from '../../lib/types.js';
import { createReviewBoardRunStore } from './review-board-run-store.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function board(
  featureId: string,
  headSha: string | null,
  reviewUpdatedAt = '2026-01-01T00:01:00.000Z',
): ReviewBoard {
  return {
    featureId,
    repoId: 'r1',
    pull: {
      number: 7,
      title: 'Harden approvals',
      url: 'https://github.com/acme/app/pull/7',
      headSha,
    },
    worktreePath: 'C:\\repo',
    baseBranch: 'main',
    changedFiles: 0,
    model: {
      projectType: 'web',
      projectTypeConfidence: 1,
      primaryLanguages: [],
      secondaryLanguages: [],
      changedComponents: [],
      changedModules: [],
      changedRuntimePaths: [],
      configurationSystems: [],
      testSignals: [],
      deploymentModel: 'desktop',
      contracts: [],
      blastRadiusDimensions: [],
      confidence: 1,
      evidence: [],
    },
    perspectives: [
      {
        id: 'security',
        name: 'Security',
        why: 'why',
        source: 'core',
        status: 'approved',
        risk: 'low',
        findings: [],
      },
    ],
    recommendation: 'approve',
    summary: { open: 0, blocking: 0, warnings: 0, suggestions: 0 },
    reviewUpdatedAt,
    generatedAt: '2026-01-01T00:02:00.000Z',
  };
}

function api(getReviewBoard: ReturnType<typeof vi.fn>) {
  return {
    getReviewBoard,
    getPrReview: vi.fn(),
    analyzeReviewBoardPerspective: vi.fn(),
    pullLatestPrReview: vi.fn(),
  };
}

describe('review-board-run-store approval identity', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('revalidates on reload and preserves sign-off when the identity is unchanged', async () => {
    const featureId = 'feature-a';
    const getReviewBoard = vi
      .fn()
      .mockResolvedValueOnce(board(featureId, 'sha-a'))
      .mockResolvedValueOnce(board(featureId, 'sha-a'));
    const store = createReviewBoardRunStore();
    const client = api(getReviewBoard);

    await store.load(featureId, client);
    store.setPerspectiveReviewed(featureId, 'security', true);
    store.markPrReviewed(featureId, ['security']);

    await store.load(featureId, client);
    const state = store.getState(featureId).signoff;

    expect(getReviewBoard).toHaveBeenCalledTimes(2);
    expect(state.identity?.reviewedCommit).toBe('sha-a');
    expect(state.prReviewedAt).not.toBeNull();
    expect(state.perspectives.security).toBeTruthy();
    expect(state.history).toHaveLength(0);
  });

  it('invalidates current sign-off when the reviewed commit or evidence revision changes', async () => {
    const featureId = 'feature-b';
    const getReviewBoard = vi
      .fn()
      .mockResolvedValueOnce(board(featureId, 'sha-a', '2026-01-01T00:01:00.000Z'))
      .mockResolvedValueOnce(board(featureId, 'sha-b', '2026-01-01T00:03:00.000Z'));
    const store = createReviewBoardRunStore();
    const client = api(getReviewBoard);

    await store.load(featureId, client);
    store.setPerspectiveReviewed(featureId, 'security', true);
    store.markPrReviewed(featureId, ['security']);

    await store.load(featureId, client);
    const state = store.getState(featureId).signoff;

    expect(state.identity?.reviewedCommit).toBe('sha-b');
    expect(state.prReviewedAt).toBeNull();
    expect(state.perspectives).toEqual({});
    expect(state.history).toHaveLength(1);
    expect(state.notice?.reason).toBe('identity-changed');
  });

  it('treats legacy identity-less sign-off as historical only', async () => {
    const featureId = 'feature-c';
    window.localStorage.setItem(
      `rb-signoff:${featureId}`,
      JSON.stringify({
        perspectives: { security: '2026-01-01T00:00:00.000Z' },
        prReviewedAt: '2026-01-01T00:01:00.000Z',
      }),
    );

    const store = createReviewBoardRunStore();
    await store.load(
      featureId,
      api(vi.fn().mockResolvedValue(board(featureId, 'sha-c'))),
    );
    const state = store.getState(featureId).signoff;

    expect(state.prReviewedAt).toBeNull();
    expect(state.perspectives).toEqual({});
    expect(state.history).toHaveLength(1);
    expect(state.notice?.reason).toBe('legacy-missing-identity');
  });

  it('keeps stored approvals during transport failure and restores certification on a same-identity retry', async () => {
    const featureId = 'feature-d';
    const getReviewBoard = vi
      .fn()
      .mockResolvedValueOnce(board(featureId, 'sha-a'))
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce(board(featureId, 'sha-a'));
    const store = createReviewBoardRunStore();
    const client = api(getReviewBoard);

    await store.load(featureId, client);
    store.setPerspectiveReviewed(featureId, 'security', true);
    store.markPrReviewed(featureId, ['security']);

    await store.load(featureId, client);
    let state = store.getState(featureId).signoff;
    expect(state.identityStatus).toBe('unknown');
    expect(state.identityError).toMatch(/timed out/i);
    expect(state.perspectives.security).toBeTruthy();
    expect(state.prReviewedAt).toBeTruthy();

    await store.load(featureId, client);
    state = store.getState(featureId).signoff;
    expect(state.identityStatus).toBe('fresh');
    expect(state.perspectives.security).toBeTruthy();
    expect(state.prReviewedAt).toBeTruthy();
    expect(state.history).toHaveLength(0);
  });

  it('distinguishes unknown refresh failures from authoritative missing identity', async () => {
    const featureId = 'feature-e';
    const getReviewBoard = vi
      .fn()
      .mockRejectedValueOnce(new Error('server unavailable'))
      .mockResolvedValueOnce(board(featureId, null));
    const store = createReviewBoardRunStore();
    const client = api(getReviewBoard);

    await store.load(featureId, client);
    expect(store.getState(featureId).signoff.identityStatus).toBe('unknown');

    await store.load(featureId, client);
    const state = store.getState(featureId).signoff;
    expect(state.identityStatus).toBe('missing');
    expect(state.identityError).toBeNull();
  });

  it('ignores a slow older response after a newer forced reload wins', async () => {
    const featureId = 'feature-f';
    const slow = deferred<ReviewBoard>();
    const fast = deferred<ReviewBoard>();
    const getReviewBoard = vi
      .fn()
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(fast.promise);
    const store = createReviewBoardRunStore();
    const client = api(getReviewBoard);

    const firstLoad = store.load(featureId, client);
    const secondLoad = store.load(featureId, client, true);
    fast.resolve(board(featureId, 'sha-new', '2026-01-01T00:04:00.000Z'));
    await secondLoad;
    slow.resolve(board(featureId, 'sha-old', '2026-01-01T00:01:00.000Z'));
    await firstLoad;

    const state = store.getState(featureId);
    expect(state.board?.pull.headSha).toBe('sha-new');
    expect(state.signoff.identity?.reviewedCommit).toBe('sha-new');
  });
});
