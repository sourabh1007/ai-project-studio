import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { ReviewBoardPage } from './review-board-page.js';
import type { ApiClient } from '../../lib/api.js';
import type { PrCommentThread, PrReview, ReviewBoard } from '../../lib/types.js';
import { reviewBoardRunStore } from './review-board-run-store.js';

vi.mock('../../hooks/use-agent-usage.js', () => ({
  useAgentUsage: () => ({
    aic: 12.5, operations: 1, unknownOperations: 0, running: false, snapshots: [],
    byFeature: {}, incompleteFeatures: 0, loading: false, error: false,
  }),
}));
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
    analyzeReviewBoardPerspectives: vi.fn(async () => {}),
    pullLatestPrReview: vi.fn(),
    getMetaPools: vi.fn(),
    chatReviewBoard: vi.fn(),
  };
}

async function completedClient(value: ReviewBoard) {
  const c = client(vi.fn().mockResolvedValue(value)) as ApiClient;
  c.approvePrReview = vi.fn().mockResolvedValue({ approved: true, state: 'approved' });
  c.analyzeReviewBoardPerspectives = vi.fn<ApiClient['analyzeReviewBoardPerspectives']>(
    async (_id, emit) => {
      for (const perspective of value.perspectives) emit({
        type: 'analyzed', analysis: {
          perspectiveId: perspective.id, perspective, skipped: false, skipReason: null,
          summary: 'Reviewed source and callers.', rationale: [], checks: [],
        },
      });
    },
  );
  await reviewBoardRunStore.analyze(value.featureId, c, { waitForGraph: false });
  return c;
}

describe('ReviewBoardPage sign-off identity', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('replaces a completed review action with confirmed remote approval, not another analysis', async () => {
    const value = board('f-approve-complete', 'sha-a');
    const c = await completedClient(value);
    const approval = deferred<{ approved: true; state: 'approved' }>();
    vi.mocked(c.approvePrReview).mockReturnValue(approval.promise);
    render(<ApiProvider value={c}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    const button = await screen.findByRole('button', { name: 'Approve PR' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveClass('rb-act-success');
    expect(screen.queryByText('Start Review again')).toBeNull();
    fireEvent.click(button);
    expect(c.approvePrReview).not.toHaveBeenCalled();
    const submit = screen.getByRole('button', { name: 'Submit approval' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(c.approvePrReview).toHaveBeenCalledOnce();
    expect(c.approvePrReview).toHaveBeenCalledWith(value.featureId, { expectedHeadSha: 'sha-a' });
    approval.resolve({ approved: true, state: 'approved' });
    expect(await screen.findByRole('button', { name: 'Approved' })).toBeDisabled();
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await screen.findByRole('button', { name: 'Start Review' });
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce();
  });

  it('shows an existing preparation run without loading or starting a second board', async () => {
    const featureId = 'f-open-preparing';
    const c = client(vi.fn().mockResolvedValue(board(featureId, 'sha-a'))) as ApiClient;
    const pending = deferred<PrReview>();
    c.getPrReview = vi.fn().mockReturnValue(pending.promise);
    reviewBoardRunStore.enqueueBulk([featureId], c);
    const root = render(<ApiProvider value={c}><ReviewBoardPage featureId={featureId} /></ApiProvider>);
    expect(await screen.findByRole('status')).toHaveTextContent(/change graph|evidence/i);
    expect(c.getReviewBoard).not.toHaveBeenCalled();
    expect(c.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
    root.unmount();
    pending.resolve(review(featureId, 'sha-a'));
    await waitFor(() => expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce());
  });

  it('retains completed evidence and surfaces a failed approval without rerunning review', async () => {
    const value = board('f-approve-failed', 'sha-a');
    const c = await completedClient(value);
    vi.mocked(c.approvePrReview).mockRejectedValue(new Error('Provider rejected approval.'));
    render(<ApiProvider value={c}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    const button = await screen.findByRole('button', { name: 'Approve PR' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Submit approval' }));
    await screen.findByText('Provider rejected approval.');
    expect(screen.getByRole('button', { name: 'Submit approval' })).toBeEnabled();
    expect(reviewBoardRunStore.getState(value.featureId).progress.security.status).toBe('done');
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce();
  });

  it('does not submit an approval if the reviewed identity changes while confirmation is open', async () => {
    const value = board('f-approve-stale', 'sha-a');
    const c = await completedClient(value);
    render(<ApiProvider value={c}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    const button = await screen.findByRole('button', { name: 'Approve PR' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    vi.mocked(c.getReviewBoard).mockResolvedValue(board(value.featureId, 'sha-b'));
    fireEvent(window, new Event('focus'));
    await screen.findByTitle('Reviewing commit sha-b');
    fireEvent.click(screen.getByRole('button', { name: 'Submit approval' }));
    await screen.findByText('The review changed. Close this dialog and verify the latest results.');
    expect(c.approvePrReview).not.toHaveBeenCalled();
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce();
  });

  it('does not treat a static recommendation as completed AI review or approve blocking findings', async () => {
    const initial = board('f-approve-not-run', 'sha-a');
    const c = client(vi.fn().mockResolvedValue(initial)) as ApiClient;
    const root = render(<ApiProvider value={c}><ReviewBoardPage featureId={initial.featureId} /></ApiProvider>);
    await screen.findByRole('button', { name: 'Start Review' });
    expect(screen.queryByRole('button', { name: 'Approve PR' })).toBeNull();
    root.unmount();
    const value = board('f-approve-blocking', 'sha-a');
    value.perspectives[0].findings = [{
      id: 'security/blocking', title: 'Blocking issue', severity: 'high', detail: 'Verify before approval.',
      perspectiveId: 'security', status: 'blocked', evidence: [],
    }];
    const complete = await completedClient(value);
    render(<ApiProvider value={complete}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    const approve = await screen.findByRole('button', { name: 'Approve PR' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('title', 'Resolve blocking findings before approving');
  });

  it('shows specific project context and opens all changed files, including files without text diffs', async () => {
    const value = board('f-files', 'sha-a');
    value.changedFiles = 2;
    value.model.primaryLanguages = ['C#'];
    value.model.changedComponents = ['QueryEngine'];
    const pr = review(value.featureId, 'sha-a');
    pr.changeGraph.projects = [
      { id: 'sql', name: 'SqlEngine', path: 'src/SqlEngine.csproj' },
      { id: 'caller', name: 'UnchangedCaller', path: 'src/Caller.csproj' },
    ];
    pr.changeGraph.nodes = [
      { path: 'src/query.cs', projectId: 'sql', module: null, category: 'code', kind: 'changed', changeKind: 'modified', diff: '+new query', whatItDoes: '', whatChanged: '', review: [] },
      { path: 'assets/icon.png', projectId: 'sql', module: null, category: 'code', kind: 'changed', changeKind: 'added', diff: '', whatItDoes: '', whatChanged: '', review: [] },
      { path: 'src/caller.cs', projectId: 'caller', module: null, category: 'code', kind: 'boundary', changeKind: null, diff: '', whatItDoes: '', whatChanged: '', review: [] },
    ];
    const c = client(vi.fn().mockResolvedValue(value));
    c.getPrReview = vi.fn().mockResolvedValue(pr);
    render(<ApiProvider value={c as ApiClient}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    await screen.findByText('SqlEngine', { selector: 'summary span' });
    expect(screen.getByText(/12.5.*AIC/)).toBeTruthy();
    expect(screen.getByText('src/SqlEngine.csproj')).toBeTruthy();
    expect(screen.getByText('QueryEngine')).toBeTruthy();
    expect(screen.queryByText('UnchangedCaller')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View 2 changed files' }));
    expect(screen.getByRole('dialog', { name: 'Diff for Changed files' })).toBeTruthy();
    expect(screen.getByText('src/query.cs')).toBeTruthy();
    expect(screen.getByText('assets/icon.png')).toBeTruthy();
    expect(screen.queryByText('src/caller.cs')).toBeNull();
    expect(screen.getByText(/No text diff is available/)).toBeTruthy();
  });

  it('opens a posting confirmation instead of resolving locally and saves resolution only after posting', async () => {
    const value = board('f-post-finding', 'sha-a');
    const finding = {
      id: 'security/ai-0', perspectiveId: 'security', title: 'Buffer issue',
      detail: 'Hold the buffer until completion.', severity: 'high' as const, status: 'warning' as const,
      evidence: [{
        source: 'src/buffer.cpp', reason: 'Premature release', confidence: 1, direct: false,
        location: { path: 'src/buffer.cpp', line: 20, side: 'RIGHT' as const },
      }],
    };
    value.perspectives[0].findings = [finding];
    const pr = review(value.featureId, 'sha-a');
    pr.changeGraph.nodes = [{
      path: 'src/buffer.cpp', projectId: 'project', module: null, category: 'code', kind: 'changed',
      changeKind: 'modified', diff: '@@ -20 +20 @@\n-release();\n+release(buffer);',
      whatItDoes: '', whatChanged: '', review: [],
    }];
    const c = client(vi.fn().mockResolvedValue(value));
    c.getPrReview = vi.fn().mockResolvedValue(pr);
    c.addPrReviewComment = vi.fn().mockResolvedValue({
      id: 't1', path: 'src/buffer.cpp', line: 20, status: 'active', comments: [],
    });
    render(<ApiProvider value={c as ApiClient}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    const action = await screen.findByRole('button', { name: 'Post and resolve' });
    await waitFor(() => expect(action).toBeEnabled());
    fireEvent.click(action);
    expect(screen.getByRole('dialog', { name: 'Post and resolve' })).toBeInTheDocument();
    expect(c.addPrReviewComment).not.toHaveBeenCalled();
    expect(reviewBoardRunStore.getState(value.featureId).resolutions[finding.id]).toBeUndefined();
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'My edited comment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm post and resolve' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Post and resolve' })).toBeNull());
    expect(c.addPrReviewComment).toHaveBeenCalledOnce();
    expect(c.addPrReviewComment).toHaveBeenCalledWith(value.featureId, {
      path: 'src/buffer.cpp', line: 20, body: 'My edited comment', expectedHeadSha: 'sha-a',
    });
    expect(reviewBoardRunStore.getState(value.featureId).resolutions[finding.id]).toBe('resolved');
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
  });

  it.each(['refresh', 'switch'])('does not resolve a replacement finding after a %s during posting', async (transition) => {
    const featureId = `f-post-${transition}`;
    const value = board(featureId, 'sha-a');
    value.perspectives[0].findings = [{
      id: 'security/ai-0', perspectiveId: 'security', title: 'Old finding', detail: 'src/a.ts:20',
      severity: 'high', status: 'warning', evidence: [],
    }];
    const pr = review(featureId, 'sha-a');
    pr.changeGraph.nodes = [{
      path: 'src/a.ts', projectId: 'project', module: null, category: 'code', kind: 'changed',
      changeKind: 'modified', diff: '@@ -20 +20 @@\n+new', whatItDoes: '', whatChanged: '', review: [],
    }];
    const replacementId = transition === 'switch' ? `${featureId}-next` : featureId;
    const replacement = board(replacementId, 'sha-b');
    replacement.perspectives[0].findings = [{
      ...value.perspectives[0].findings[0], title: 'Replacement finding',
    }];
    const pending = deferred<PrCommentThread>();
    const c = client(vi.fn().mockResolvedValueOnce(value).mockResolvedValue(replacement));
    c.getPrReview = vi.fn().mockResolvedValue(pr);
    c.addPrReviewComment = vi.fn().mockReturnValue(pending.promise);
    const root = render(<ApiProvider value={c as ApiClient}><ReviewBoardPage featureId={featureId} /></ApiProvider>);
    const action = await screen.findByRole('button', { name: 'Post and resolve' });
    await waitFor(() => expect(action).toBeEnabled());
    fireEvent.click(action);
    fireEvent.click(screen.getByRole('checkbox', { name: /This older finding/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm post and resolve' }));
    if (transition === 'switch') {
      root.rerender(<ApiProvider value={c as ApiClient}><ReviewBoardPage featureId={replacementId} /></ApiProvider>);
    } else {
      fireEvent(window, new Event('focus'));
    }
    await screen.findByText('Replacement finding');
    pending.resolve({ id: 't1', path: 'src/a.ts', line: 20, status: 'active', comments: [] });
    if (transition === 'refresh') await screen.findByText(/Comment posted, but the review changed/);
    else await waitFor(() => expect(reviewBoardRunStore.getState(featureId).resolutions['security/ai-0']).toBe('resolved'));
    expect(reviewBoardRunStore.getState(replacementId).resolutions['security/ai-0']).toBeUndefined();
    expect(c.addPrReviewComment).toHaveBeenCalledOnce();
  });

  it('makes changed-file loading errors retryable without a dead file-count button', async () => {
    const value = board('f-files-retry', 'sha-a');
    value.changedFiles = 1;
    const request = deferred<PrReview>();
    const c = client(vi.fn().mockResolvedValue(value));
    c.getPrReview = vi.fn().mockImplementation(() => request.promise);
    render(<ApiProvider value={c as ApiClient}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'View 1 changed files' }));
    expect(screen.getByText('Loading changed files…')).toBeTruthy();
    request.reject(new Error('Graph temporarily unavailable'));
    const retry = await screen.findByRole('button', { name: 'Retry loading files' });
    vi.mocked(c.getPrReview!).mockResolvedValue(review(value.featureId, 'sha-a'));
    fireEvent.click(retry);
    await screen.findByText('Showing 0 of 1 changed files captured in the change graph.');
    expect(screen.queryByRole('button', { name: 'Retry loading files' })).toBeNull();
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
      await screen.findByRole('button', { name: 'Mark this perspective reviewed' }),
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
    // The header renders before the effect selects and renders a perspective.
    const perspectiveReview = await screen.findByRole('button', { name: 'Mark this perspective reviewed' });
    await waitFor(() => expect(perspectiveReview).toBeEnabled());
    fireEvent.click(perspectiveReview);
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
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Mark this perspective reviewed' })).toBeEnabled(),
    );

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
