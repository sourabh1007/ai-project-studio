import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { ReviewBoardPage } from './review-board-page.js';
import type { ApiClient } from '../../lib/api.js';
import type { PrReview, ReviewBoard } from '../../lib/types.js';

vi.mock('../../hooks/use-usage-stream.js', () => ({
  useUsageStream: () => ({
    sessions: {},
    usageByKey: {},
    repositoryContexts: {},
    prReviews: {},
    contextStatus: {},
    automations: {},
    subagents: {},
    reviewBoardActivity: {},
    fileChangesBySession: {},
  }),
}));
vi.mock('../pr-review-page/change-graph.js', () => ({
  ChangeGraph: () => <div>Change graph</div>,
}));
vi.mock('../pr-review-page/pr-comments.js', () => ({
  usePrComments: () => ({
    threads: [],
    loading: false,
    error: null,
    featureId: 'f1',
    reload: () => undefined,
    add: async () => null,
    setStatus: async () => undefined,
  }),
  CommentableDiff: () => <div>Diff</div>,
}));
vi.mock('./review-board-run-store.js', async () => {
  const actual = await vi.importActual<typeof import('./review-board-run-store.js')>(
    './review-board-run-store.js',
  );
  return {
    ...actual,
    reviewBoardRunStore: actual.createReviewBoardRunStore(),
  };
});

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
      title: 'Trust review identity',
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
      blastRadiusDimensions: ['runtime'],
      confidence: 1,
      evidence: [],
    },
    perspectives: [
      {
        id: 'security',
        name: 'Security',
        why: 'Review auth and data flow.',
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

function review(featureId: string, headSha: string | null): PrReview {
  return {
    featureId,
    repoId: 'r1',
    pull: {
      number: 7,
      title: 'Trust review identity',
      url: 'https://github.com/acme/app/pull/7',
    },
    worktreePath: 'C:\\repo',
    headSha,
    baseBranch: 'main',
    description: null,
    problemStatement: {
      status: 'ready',
      metaSessionId: null,
      usage: null,
      failure: null,
      activity: [],
      generatedAt: null,
      content: null,
      sufficient: true,
    },
    changeGraph: {
      status: 'ready',
      metaSessionId: null,
      usage: null,
      failure: null,
      activity: [],
      generatedAt: null,
      projects: [],
      nodes: [],
      edges: [],
    },
    changedFiles: 0,
    timestamps: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    },
  };
}

function client(getReviewBoard: ReturnType<typeof vi.fn>): Partial<ApiClient> {
  return {
    getReviewBoard,
    getPrReview: vi.fn((featureId: string) => Promise.resolve(review(featureId, 'sha-a'))),
    analyzeReviewBoardPerspective: vi.fn(),
    pullLatestPrReview: vi.fn(),
    getMetaPools: vi.fn(),
    chatReviewBoard: vi.fn(),
  };
}

describe('ReviewBoardPage sign-off identity', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('fails closed visibly when the reviewed commit identity is unavailable', async () => {
    render(
      <ApiProvider
        value={client(vi.fn().mockResolvedValue(board('f-missing', null))) as ApiClient}
      >
        <ReviewBoardPage featureId="f-missing" />
      </ApiProvider>,
    );

    expect(
      await screen.findByText(/sign-off is unavailable because the current board/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Mark this perspective reviewed' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark PR reviewed' })).toBeDisabled();
  });

  it('revalidates on remount and clears stale approvals when the reviewed identity changes', async () => {
    const featureId = 'f-remount-change';
    const getReviewBoard = vi
      .fn()
      .mockResolvedValueOnce(board(featureId, 'sha-a'))
      .mockResolvedValueOnce(board(featureId, 'sha-b', '2026-01-01T00:03:00.000Z'));
    const api = client(getReviewBoard) as ApiClient;

    const first = render(
      <ApiProvider value={api}>
        <ReviewBoardPage featureId={featureId} />
      </ApiProvider>,
    );

    await screen.findByText('0/1 reviewed');
    fireEvent.click(screen.getByRole('button', { name: 'Mark this perspective reviewed' }));
    await screen.findByText('1/1 reviewed');
    fireEvent.click(screen.getByRole('button', { name: 'Mark PR reviewed' }));
    await screen.findByRole('button', { name: 'Re-open PR' });

    first.unmount();

    render(
      <ApiProvider value={api}>
        <ReviewBoardPage featureId={featureId} />
      </ApiProvider>,
    );

    expect(
      await screen.findByText(/review sign-off was cleared because the reviewed commit or evidence changed/i),
    ).toBeInTheDocument();
    expect(screen.getByText('0/1 reviewed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark PR reviewed' })).toBeDisabled();
  });

  it('keeps the cached board visible and temporarily gates approval during visibility refresh failures', async () => {
    const featureId = 'f-visibility-refresh';
    const refresh = deferred<ReviewBoard>();
    const getReviewBoard = vi
      .fn()
      .mockResolvedValueOnce(board(featureId, 'sha-a'))
      .mockReturnValueOnce(refresh.promise)
      .mockResolvedValueOnce(board(featureId, 'sha-a'));
    const api = client(getReviewBoard) as ApiClient;

    render(
      <ApiProvider value={api}>
        <ReviewBoardPage featureId={featureId} />
      </ApiProvider>,
    );

    await screen.findByText('Security');
    expect(screen.getByRole('button', { name: 'Mark this perspective reviewed' })).toBeEnabled();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    fireEvent(document, new Event('visibilitychange'));

    expect(
      await screen.findByText(/revalidating review sign-off against the latest reviewed commit/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Security')).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: 'Mark this perspective reviewed' }),
    ).toBeDisabled();

    refresh.reject(new Error('timed out'));
    expect(
      await screen.findByText(/could not refresh the reviewed commit identity: timed out/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Security')).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: 'Mark this perspective reviewed' }),
    ).toBeDisabled();

    fireEvent(window, new Event('focus'));
    await waitFor(() =>
      expect(
        screen.queryByText(/could not refresh the reviewed commit identity: timed out/i),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Mark this perspective reviewed' }),
      ).toBeEnabled(),
    );
  });
});
