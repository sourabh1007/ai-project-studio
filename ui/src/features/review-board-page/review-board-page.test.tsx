import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { ReviewBoardPage } from './review-board-page.js';
import type { ApiClient } from '../../lib/api.js';
import type { PrCommentThread, PrReview, ReviewBoard, ReviewPublication } from '../../lib/types.js';
import { reviewBoardRunStore } from './review-board-run-store.js';
import { AutomationBoundary, AutomationReadinessProvider } from '../../app/automation-readiness.js';
import { PROVIDER_CHANGED } from '../../lib/provider-selection.js';

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
    getMetaModels: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn().mockResolvedValue([]),
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

async function openDetails() {
  fireEvent.click(await screen.findByRole('button', { name: 'Run details and perspectives' }));
  return screen.findByRole('dialog', { name: 'Run details and perspectives' });
}

function immutable(value: ReviewBoard, id = 'run-one', status: 'prepared' | 'completed' | 'running' | 'cancelled' | 'failed' = 'completed'): ReviewBoard {
  const run = {
    id, revision: 3, status, options: { model: 'named-model' },
    providerId: 'cli', model: 'named-model', perspectiveIds: value.perspectives.map((p) => p.id),
    context: { fingerprint: 'context', skills: [], businessRequirements: '', evidence: 'diff', warnings: [] },
    headSha: value.pull.headSha ?? null, graphGeneratedAt: 'graph', startedAt: '2026-01-01', failures: {},
  };
  return { ...value, run, analyses: status === 'completed' ? Object.fromEntries(value.perspectives.map((p) => [p.id, {
    perspectiveId: p.id, perspective: p, skipped: false, skipReason: null, summary: 'Inspected source.',
    rationale: [], checks: [], runId: id, attemptId: `${id}/${p.id}`, assessment: 'no-concerns',
  }])) : {} };
}

describe('ReviewBoardPage sign-off identity', () => {
  it('opens a focused chat without diagnostics or automatic AI calls, retaining whole-review and perspective scope', async () => {
    const value = immutable(board('f-clean-chat', 'sha-a'));
    const c = client(vi.fn().mockResolvedValue(value)) as ApiClient;
    c.chatReviewBoard = vi.fn().mockResolvedValue({ answer: 'The captured patch preserves the operation key.' });
    render(<ApiProvider value={c}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Review agent' }));
    let dialog = screen.getByRole('dialog', { name: 'Review agent' });
    expect(within(dialog).getByText('#7 · Whole review')).toBeVisible();
    expect(within(dialog).queryByText('Run information')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Run details and perspectives' })).not.toBeInTheDocument();
    expect(c.chatReviewBoard).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Message the review agent'), { target: { value: 'Why is this safe?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send message' }));
    expect(await within(dialog).findByText('The captured patch preserves the operation key.')).toBeVisible();
    expect(c.chatReviewBoard).toHaveBeenLastCalledWith(value.featureId, null,
      [{ role: 'user', content: 'Why is this safe?' }], null);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await openDetails();
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this perspective' }));
    dialog = screen.getByRole('dialog', { name: 'Review agent' });
    expect(within(dialog).getByText('#7 · Security')).toBeVisible();
    fireEvent.change(within(dialog).getByLabelText('Message the review agent'), { target: { value: 'Explain this assessment.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(c.chatReviewBoard).toHaveBeenLastCalledWith(value.featureId, 'security',
      [{ role: 'user', content: 'Explain this assessment.' }], {
        status: 'approved', risk: 'low', findings: [],
      }));
    expect(c.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
  });

  it('keeps telemetry and detailed checks collapsed while preserving assessment evidence and sign-off', async () => {
    const value = immutable(board('f-clean-details', 'sha-a'));
    value.analyses!.security.rationale = [{ label: 'Retry boundary', detail: 'The same key reaches both attempts.' }];
    value.analyses!.security.checks = [{ item: 'Check the operation key', finding: 'The caller retains it.', status: 'pass' }];
    const c = client(vi.fn().mockResolvedValue(value)) as ApiClient;
    render(<ApiProvider value={c}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    const dialog = await openDetails();
    expect(within(dialog).getByText('Run information').closest('details')).not.toHaveAttribute('open');
    expect(within(dialog).getByText('Review history:')).not.toBeVisible();
    expect(within(dialog).getByText('The same key reaches both attempts.')).not.toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Mark this perspective reviewed' })).toBeVisible();
    fireEvent.click(within(dialog).getByText('Assessment evidence'));
    expect(within(dialog).getByText('The same key reaches both attempts.')).toBeVisible();
    expect(within(dialog).getByText('The caller retains it.')).toBeVisible();
    fireEvent.click(within(dialog).getByText('Run information'));
    expect(within(dialog).getByText('Review history:')).toBeVisible();
    expect(c.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
  });

  it('animates truthful completion progress and refreshes explanations while the original stream stays open', async () => {
    let current = immutable(board('f-live-progress', 'sha-a'), 'live-progress', 'running');
    current.perspectives.push({ ...current.perspectives[0], id: 'testing', name: 'Testing' },
      { ...current.perspectives[0], id: 'api-contract', name: 'API contract' });
    current.run!.perspectiveIds = current.perspectives.map((p) => p.id);
    current.solution = 'The review has not explained the solution yet. Retry the incomplete review.';
    const c = client(vi.fn(async () => current)) as ApiClient;
    const end = deferred<void>();
    let send!: Parameters<ApiClient['analyzeReviewBoardPerspectives']>[1];
    c.analyzeReviewBoardPerspectives = vi.fn(async (_id, emit) => { send = emit; await end.promise; });
    const running = reviewBoardRunStore.analyze(current.featureId, c, { waitForGraph: false });
    await waitFor(() => expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce());
    const interval = vi.spyOn(window, 'setInterval');
    render(<ApiProvider value={c}><ReviewBoardPage featureId={current.featureId} /></ApiProvider>);
    const progress = await screen.findByRole('progressbar', { name: 'Review progress' });
    act(() => {
      send({ type: 'analyzing', perspectiveId: 'security' });
      send({ type: 'analyzing', perspectiveId: 'testing' });
    });
    expect(progress).toHaveAttribute('aria-valuenow', '0');
    expect(progress).toHaveAttribute('aria-valuetext', '0 of 3 checks finished; 2 active');
    expect(screen.queryByText(/The review has not explained the solution yet/)).not.toBeInTheDocument();
    const result = { perspectiveId: 'security', perspective: current.perspectives[0], runId: 'live-progress',
      skipped: false, skipReason: null, summary: 'Inspected source.', rationale: [], checks: [] };
    act(() => send({ type: 'analyzed', analysis: result }));
    expect(progress).toHaveAttribute('aria-valuenow', '1');
    expect(progress).toHaveAttribute('aria-valuetext', '1 of 3 checks finished; 1 active');
    current = { ...current, run: { ...current.run!, revision: 4 }, analyses: { security: result },
      problem: 'Retries could duplicate a charge.', solution: 'Reuse the operation key for each retry.' };
    const poll = interval.mock.calls.find(([, delay]) => delay === 2000)![0] as () => void;
    await act(async () => { poll(); });
    expect(await screen.findByText('Reuse the operation key for each retry.')).toBeVisible();
    expect(screen.getByText('Retries could duplicate a charge.')).toBeVisible();
    expect(progress).toHaveAttribute('aria-valuenow', '1');
    expect(reviewBoardRunStore.getState(current.featureId).running).toBe(true);
    act(() => {
      send({ type: 'failed', perspectiveId: 'testing', error: 'Tool unavailable' });
      send({ type: 'analyzed', analysis: { ...result, perspectiveId: 'api-contract',
        perspective: current.perspectives[2], skipped: true, skipReason: 'No API changes' } });
    });
    expect(progress).toHaveAttribute('aria-valuenow', '3');
    current = { ...current, run: { ...current.run!, status: 'completed', failures: { testing: 'Tool unavailable' } } };
    await act(async () => { end.resolve(); await running; });
    expect(screen.queryByRole('progressbar', { name: 'Review progress' })).not.toBeInTheDocument();
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce();
    expect(c.analyzeReviewBoardPerspective).not.toHaveBeenCalled();
    interval.mockRestore();
  });

  it('shows saved failures after reopening and offers an explicit retry without starting analysis on load', async () => {
    const value = immutable(board('f-saved-failures', 'sha-a'), 'failed-run', 'failed');
    value.perspectives.push({ ...value.perspectives[0], id: 'testing', name: 'Testing' });
    value.run!.perspectiveIds.push('testing');
    value.run!.failures = { security: 'Native engine startup failed', testing: 'Native engine startup failed' };
    const c = client(vi.fn().mockResolvedValue(value)) as ApiClient;
    render(<ApiProvider value={c}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    expect(await screen.findByText(/2 perspectives couldn't be analysed.*not a clean review/)).toBeVisible();
    expect(screen.getByText('Native engine startup failed')).not.toBeVisible();
    fireEvent.click(screen.getByText('Technical details'));
    expect(screen.getByText('Native engine startup failed')).toBeVisible();
    expect(c.analyzeReviewBoardPerspective).not.toHaveBeenCalled();
    expect(c.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
    const retry = vi.spyOn(reviewBoardRunStore, 'retryFailed').mockResolvedValue();
    expect(screen.queryByRole('button', { name: 'Retry failed' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry incomplete review' }));
    expect(retry).toHaveBeenCalledWith(value.featureId, expect.anything(), { includeIncomplete: true });
    expect(screen.queryByRole('button', { name: 'Analyze current' })).not.toBeInTheDocument();
    retry.mockRestore();
  });

  it('persists finding disposition, refreshes the board and invalidates prior run sign-off', async () => {
    let current = immutable(board('f-durable-disposition', 'sha-a'));
    const finding = { id: 'security/one', perspectiveId: 'security', title: 'Retry loses the key', detail: 'Keep the operation key.',
      severity: 'high' as const, status: 'blocked' as const, evidence: [] };
    current.perspectives[0].findings = [finding];
    current.analyses!.security.assessment = 'concerns';
    current.uniqueFindings = [{ id: 'group-one', finding, observations: [finding], perspectiveIds: ['security'], skillIds: [], disposition: 'open' }];
    const c = client(vi.fn(async () => current)) as ApiClient;
    c.manageReviewBoardFindings = vi.fn(async (_featureId, input) => {
      current = { ...current, run: { ...current.run!, revision: 4 },
        uniqueFindings: [{ ...current.uniqueFindings![0], disposition: 'dismissed', dispositionReason: input.reason }] };
      return current;
    });
    render(<ApiProvider value={c}><ReviewBoardPage featureId={current.featureId} /></ApiProvider>);
    const approve = await screen.findByRole('button', { name: 'Approve PR' });
    expect(approve).toBeDisabled();
    await openDetails();
    fireEvent.click(screen.getByRole('button', { name: 'Mark this perspective reviewed' }));
    expect(reviewBoardRunStore.getState(current.featureId).signoff.perspectives.security).toBeDefined();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Review disposition' }));
    fireEvent.change(screen.getByLabelText('Disposition reason'), { target: { value: 'The current call contract supplies a stable key.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss with reason' }));
    await waitFor(() => expect(reviewBoardRunStore.getState(current.featureId).board?.run?.revision).toBe(4));
    expect(c.manageReviewBoardFindings).toHaveBeenCalledWith(current.featureId, {
      expectedRunId: 'run-one', expectedAssessmentRevision: 3, action: 'disposition', groupIds: ['group-one'],
      reason: 'The current call contract supplies a stable key.', disposition: 'dismissed',
    });
    expect(reviewBoardRunStore.getState(current.featureId).signoff.perspectives).toEqual({});
    expect(reviewBoardRunStore.getState(current.featureId).resolutions[finding.id]).toBeUndefined();
  });

  it('restores a pending publication and reconciles it without resending or fixing the blocking concern', async () => {
    const current = immutable(board('f-durable-publication', 'sha-a'));
    const finding = { id: 'security/one', perspectiveId: 'security', title: 'Retry loses the key', detail: 'Keep the operation key.',
      severity: 'high' as const, status: 'blocked' as const, evidence: [] };
    current.perspectives[0].findings = [finding];
    current.uniqueFindings = [{ id: 'group-one', finding, observations: [finding], perspectiveIds: ['security'], skillIds: [], disposition: 'open' }];
    let publication: ReviewPublication = { key: 'server-key', status: 'pending', startedAt: '2026-01-01',
      input: { expectedHeadSha: 'sha-a', expectedRunId: 'run-one', expectedAssessmentRevision: 3, body: 'Saved comment draft',
        publicationKey: JSON.stringify(['run-one', 'group-one', 'Saved comment draft', null, null, 'sha-a']) } };
    const c = client(vi.fn().mockResolvedValue(current)) as ApiClient;
    c.getReviewBoardPublications = vi.fn(async () => [publication]);
    c.reconcileReviewBoardPublication = vi.fn(async () => {
      publication = { ...publication, status: 'posted', thread: { id: 'thread', path: null, line: null, status: 'active', comments: [] } };
      return publication;
    });
    c.addPrReviewComment = vi.fn();
    render(<ApiProvider value={c}><ReviewBoardPage featureId={current.featureId} /></ApiProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Check publication' }));
    expect(screen.getByLabelText('Comment')).toHaveValue('Saved comment draft');
    expect(screen.getByRole('button', { name: 'Leave comment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile publication' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Leave a comment' })).not.toBeInTheDocument());
    expect(c.reconcileReviewBoardPublication).toHaveBeenCalledWith(current.featureId, 'server-key');
    expect(c.addPrReviewComment).not.toHaveBeenCalled();
    expect(screen.getByText('Posted · still requires review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve PR' })).toBeDisabled();
    expect(reviewBoardRunStore.getState(current.featureId).resolutions[finding.id]).toBeUndefined();
  });

  it('keeps unresolved publication recovery accessible after its original group or run is replaced', async () => {
    const current = immutable(board('f-orphaned-publication', 'sha-a'), 'replacement-run');
    let publication: ReviewPublication = { key: 'old-key', status: 'uncertain', startedAt: '2026-01-01',
      input: { expectedHeadSha: 'sha-a', expectedRunId: 'old-run', expectedAssessmentRevision: 3, body: 'Old edited comment',
        publicationKey: JSON.stringify(['old-run', 'merged-away-group', 'hash']) } };
    const c = client(vi.fn().mockResolvedValue(current)) as ApiClient;
    c.getReviewBoardPublications = vi.fn(async () => [publication]);
    c.addPrReviewComment = vi.fn();
    c.reconcileReviewBoardPublication = vi.fn(async () => {
      publication = { ...publication, status: 'posted' };
      return publication;
    });
    render(<ApiProvider value={c}><ReviewBoardPage featureId={current.featureId} /></ApiProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Review publication recovery' }));
    fireEvent.click(screen.getByText('Saved comment and operation identity'));
    expect(screen.getByText('Old edited comment')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile publication 1' }));
    await screen.findByText('Comment 1 — posted');
    expect(c.reconcileReviewBoardPublication).toHaveBeenCalledWith(current.featureId, 'old-key');
    expect(c.addPrReviewComment).not.toHaveBeenCalled();
    expect(reviewBoardRunStore.getState(current.featureId).resolutions).toEqual({});
  });

  it('pins remote approval to the current run and assessment, not only its head', async () => {
    const value = immutable(board('f-run-approval', 'sha-a'));
    const c = client(vi.fn().mockResolvedValue(value)) as ApiClient;
    c.approvePrReview = vi.fn().mockResolvedValue({ approved: true, state: 'approved' });
    render(<ApiProvider value={c}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve PR' }));
    expect(screen.getByText('Code-only review complete')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Submit approval' }));
    await waitFor(() => expect(c.approvePrReview).toHaveBeenCalledWith(value.featureId, {
      expectedHeadSha: 'sha-a', expectedRunId: 'run-one', expectedAssessmentRevision: 3,
    }));
  });

  it.each(['ambiguous', 'not-assessed'] as const)('does not certify unresolved %s business requirements', async (assessment) => {
    const base = board(`f-business-${assessment}`, 'sha-a');
    base.perspectives.push({ ...base.perspectives[0], id: 'business', name: 'Business' });
    const value = immutable(base);
    value.run!.context.businessRequirements = 'Only one charge is permitted.';
    value.businessMatrix = [{
      requirement: { id: 'r1', text: 'Only one charge is permitted.', source: 'Pinned PR requirements', fingerprint: 'rev-one', priority: 1 },
      assessment, explanation: 'No direct changed-path evidence establishes this rule.', findingIds: [], evidence: [],
    }];
    const c = client(vi.fn().mockResolvedValue(value)) as ApiClient;
    render(<ApiProvider value={c}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    await screen.findByRole('heading', { name: 'Review Board' });
    expect(screen.queryByText('Clarify the review criteria')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit acceptance criteria' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Review status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve PR' })).not.toBeInTheDocument();
    expect(screen.getByText('Review incomplete. No comments yet; this is not a clean result.')).toBeInTheDocument();
  });
  it('recognizes retained authoritative requirements when their duplicate prose was omitted by the context budget', async () => {
    const base = board('f-retained-requirements', 'sha-a');
    base.perspectives.push({ ...base.perspectives[0], id: 'business', name: 'Business' });
    const value = immutable(base);
    const requirement = { id: 'r1', text: 'Only one charge is permitted.', source: 'Product criteria', fingerprint: 'r1', priority: 0 };
    value.run!.context.requirements = [requirement];
    value.businessMatrix = [{ requirement, assessment: 'supported', explanation: 'Inspected changed charge guard.',
      findingIds: [], evidence: [] }];
    const c = client(vi.fn().mockResolvedValue(value)) as ApiClient;
    render(<ApiProvider value={c}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    await screen.findByRole('button', { name: 'Approve PR' });
    expect(screen.queryByText('Insufficient business context. Requirements have not been verified.')).not.toBeInTheDocument();
  });

  it('prepares a fresh saved setup before full rerun and reloads authoritative server results', async () => {
    let current = immutable(board('f-run-rerun', 'sha-a'));
    const c = client(vi.fn(async () => current)) as ApiClient;
    c.configureReviewBoard = vi.fn(async () => {
      current = immutable(current, 'run-two', 'prepared');
      return current;
    });
    c.analyzeReviewBoardPerspectives = vi.fn(async (_id, emit) => {
      expect(c.configureReviewBoard).toHaveBeenCalledOnce();
      current = immutable(current, 'run-two');
      emit({ type: 'analyzed', analysis: current.analyses!.security });
    });
    render(<ApiProvider value={c}><ReviewBoardPage featureId={current.featureId} /></ApiProvider>);
    fireEvent.click(await screen.findByLabelText('More review actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Start a new review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze current' }));
    await waitFor(() => expect(reviewBoardRunStore.getState(current.featureId).board?.run?.id).toBe('run-two'));
    await screen.findByRole('button', { name: 'Approve PR' });
    expect(c.configureReviewBoard).toHaveBeenCalledWith(current.featureId, { model: 'named-model' });
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce();
    expect(reviewBoardRunStore.getState(current.featureId).signoff.identity?.runId).toBe('run-two');
  });

  it('shows preparation progress and recovers a changed remote head with an explicit latest-evidence action', async () => {
    let current = immutable(board('f-stale-recovery', 'sha-a'), 'old-run', 'failed');
    current.run!.failures = { security: 'Old provider failure' };
    const c = client(vi.fn(async () => current)) as ApiClient;
    const preparation = deferred<ReviewBoard>();
    c.configureReviewBoard = vi.fn().mockReturnValueOnce(preparation.promise).mockImplementation(async () => {
      expect(c.pullLatestPrReview).toHaveBeenCalledOnce();
      current = immutable({ ...current, pull: { ...current.pull, headSha: 'sha-b' } }, 'latest-run', 'prepared');
      return current;
    });
    c.analyzeReviewBoardPerspectives = vi.fn(async (_id, emit) => {
      current = immutable(current, 'latest-run');
      emit({ type: 'analyzed', analysis: current.analyses!.security });
    });
    render(<ApiProvider value={c}><ReviewBoardPage featureId={current.featureId} /></ApiProvider>);
    fireEvent.click(await screen.findByLabelText('More review actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Start a new review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze current' }));
    await waitFor(() => {
      expect(c.configureReviewBoard).toHaveBeenCalledOnce();
      expect(screen.getByRole('progressbar', { name: 'Preparing review' })).toBeVisible();
    });
    expect(screen.getByRole('button', { name: 'Preparing review' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Start a new review' })).not.toBeInTheDocument();
    expect(screen.queryByText(/1 perspective couldn't be analysed/)).not.toBeInTheDocument();
    expect(c.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
    await act(async () => preparation.reject(new Error('The remote head changed. Pull the latest evidence before reviewing.')));
    const recover = await screen.findByRole('button', { name: 'Take latest & retry' });
    const status = screen.getByRole('region', { name: 'Review status' });
    expect(within(status).getByRole('heading', { name: 'Review needs fresh evidence' })).toBeVisible();
    expect(within(status).getByRole('button', { name: 'Take latest & retry' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry incomplete review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Preparing review' })).not.toBeInTheDocument();
    expect(c.pullLatestPrReview).not.toHaveBeenCalled();
    fireEvent.click(recover);
    await waitFor(() => expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce());
    await screen.findByRole('button', { name: 'Approve PR' });
    expect(c.configureReviewBoard).toHaveBeenLastCalledWith(current.featureId, { model: 'named-model' });
    expect(reviewBoardRunStore.getState(current.featureId).board?.pull.headSha).toBe('sha-b');
    expect(screen.queryByText('The remote head changed. Pull the latest evidence before reviewing.')).not.toBeInTheDocument();
  });

  it('groups saved-review gaps and keeps detailed context diagnostics available without rerunning AI', async () => {
    const base = board('f-grouped-status', 'sha-a');
    base.perspectives.push({ ...base.perspectives[0], id: 'business', name: 'Business' });
    const value = immutable(base, 'old-run');
    value.run!.status = 'failed';
    value.run!.context.warnings = ['Total context budget exhausted; saved evidence was omitted.', 'Missing source: policy.md'];
    value.run!.failures = { security: 'Provider did not complete this attempt' };
    value.analyses!.business.assessment = 'insufficient-evidence';
    const c = client(vi.fn().mockResolvedValue(value)) as ApiClient;
    c.configureReviewBoard = vi.fn();
    render(<ApiProvider value={c}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    const status = await screen.findByRole('region', { name: 'Review status' });
    expect(screen.getAllByRole('region', { name: 'Review status' })).toHaveLength(1);
    expect(within(status).getByText('Incomplete perspectives')).toBeVisible();
    expect(within(status).queryByText('Confirm what this PR must achieve')).not.toBeInTheDocument();
    expect(within(status).queryByRole('button', { name: 'Edit acceptance criteria' })).not.toBeInTheDocument();
    expect(within(status).queryByText(value.run!.context.warnings[0])).not.toBeInTheDocument();
    await openDetails();
    fireEvent.click(screen.getByText('Run information'));
    fireEvent.click(screen.getByText('Technical run information and collection notes'));
    expect(screen.getByText(value.run!.context.warnings[0])).toBeVisible();
    expect(screen.getByText('Missing source: policy.md')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve PR' })).not.toBeInTheDocument();
    expect(c.configureReviewBoard).not.toHaveBeenCalled();
    expect(c.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
  });

  it('cancels a restored running backend review explicitly without launching it again', async () => {
    let current = immutable(board('f-run-cancel', 'sha-a'), 'run-one', 'running');
    const c = client(vi.fn(async () => current)) as ApiClient;
    c.cancelReviewBoard = vi.fn(async () => {
      current = immutable(current, 'run-one', 'cancelled');
      return current;
    });
    render(<ApiProvider value={c}><ReviewBoardPage featureId={current.featureId} /></ApiProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel review' }));
    await screen.findByText('Review cancelled');
    expect(c.cancelReviewBoard).toHaveBeenCalledWith(current.featureId);
    expect(c.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Approve PR' })).not.toBeInTheDocument();
  });

  it('keeps technical collection notes in run details instead of presenting them as user-action failures', async () => {
    const value = immutable(board('f-notes-only', 'sha-a'));
    value.run!.context.warnings = ['Reference excerpt truncated: src/legacy.ts'];
    const c = client(vi.fn().mockResolvedValue(value)) as ApiClient;
    render(<ApiProvider value={c}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    await screen.findByRole('button', { name: 'Approve PR' });
    expect(screen.queryByRole('region', { name: 'Review status' })).not.toBeInTheDocument();
    await openDetails();
    fireEvent.click(screen.getByText('Run information'));
    fireEvent.click(screen.getByText('Technical run information and collection notes'));
    expect(screen.getByText(value.run!.context.warnings[0])).toBeVisible();
    expect(c.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
  });
  it('keeps check-specific evidence gaps in Details without duplicating them in the overview or changing approval', async () => {
    const value = immutable(board('f-check-gap', 'sha-a'));
    value.analyses!.security.assessment = 'insufficient-evidence';
    value.analyses!.security.summary = 'The captured patch has no caller for the permission check.';
    const c = client(vi.fn().mockResolvedValue(value)) as ApiClient;
    render(<ApiProvider value={c}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    await screen.findByRole('button', { name: 'Run details and perspectives' });
    expect(screen.queryByRole('region', { name: 'Review status' })).not.toBeInTheDocument();
    expect(screen.queryByText(value.analyses!.security.summary)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Inspect Security' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve PR' })).not.toBeInTheDocument();
    await openDetails();
    expect(await screen.findByRole('dialog', { name: 'Run details and perspectives' })).toBeVisible();
    expect(screen.getByText(value.analyses!.security.summary)).toBeVisible();
    expect(c.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
  });

  it('keeps missing business evidence visible and never certifies an empty comments list as clean', async () => {
    const base = board('f-business-gap', 'sha-a');
    base.perspectives = [{ ...base.perspectives[0], id: 'business', name: 'Business' }];
    const value = immutable(base);
    value.analyses!.business.assessment = 'insufficient-evidence';
    const c = client(vi.fn().mockResolvedValue(value)) as ApiClient;
    render(<ApiProvider value={c}><ReviewBoardPage featureId={value.featureId} /></ApiProvider>);
    await screen.findByRole('heading', { name: 'Review Board' });
    expect(screen.queryByRole('button', { name: 'Edit acceptance criteria' })).not.toBeInTheDocument();
    expect(screen.queryByText('Clarify the review criteria')).not.toBeInTheDocument();
    expect(screen.getByText('Review incomplete. No comments yet; this is not a clean result.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve PR' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No issues found/)).not.toBeInTheDocument();
  });

  it('explains an interactive-only provider before mounting or generating an agent, and recovers after switching', async () => {
    const value = board('f-policy-gate', 'sha-a');
    const c = { ...client(vi.fn().mockResolvedValue(value)),
      getProviderBootstrap: vi.fn().mockResolvedValue({
        defaultProvider: 'interactive-cli', selectionRequired: false,
        providers: [{ id: 'interactive-cli', installed: true, automation: {
          supported: false, reason: 'Automated MCP suppression cannot be verified.',
        } }],
      }),
    } as unknown as ApiClient;
    render(<ApiProvider value={c}><AutomationReadinessProvider><AutomationBoundary>
      <ReviewBoardPage featureId={value.featureId} />
    </AutomationBoundary></AutomationReadinessProvider></ApiProvider>);
    await screen.findByText(/Automated MCP suppression cannot be verified/);
    expect(c.getReviewBoard).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Start Review' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose another CLI' })).toBeEnabled();
    act(() => window.dispatchEvent(new CustomEvent(PROVIDER_CHANGED, { detail: {
      defaultProvider: 'ready-cli', selectionRequired: false,
      providers: [{ id: 'ready-cli', installed: true, automation: { supported: true, reason: null } }],
    } })));
    await waitFor(() => expect(c.getReviewBoard).toHaveBeenCalledWith(value.featureId));
    expect(screen.queryByRole('region', { name: 'Automation unavailable' })).not.toBeInTheDocument();
  });
  it('ignores a late PR response after switching features and closes the previous diff', async () => {
    const first = board('f-race-first', 'sha-first');
    const second = board('f-race-second', 'sha-second');
    const pending = deferred<PrReview>();
    const newer = review(second.featureId, 'sha-second');
    newer.changeGraph.projects = [{ id: 'new', name: 'Current project', path: 'current.proj' }];
    newer.changeGraph.nodes = [{
      path: 'new.ts', projectId: 'new', module: null, category: 'code', kind: 'changed',
      changeKind: 'modified', diff: '+new', whatItDoes: '', whatChanged: '', review: [],
    }];
    const c = client(vi.fn(async (id: string) => id === first.featureId ? first : second));
    c.getPrReview = vi.fn((id: string) => id === first.featureId ? pending.promise : Promise.resolve(newer));
    const view = render(<ApiProvider value={c as ApiClient}><ReviewBoardPage featureId={first.featureId} /></ApiProvider>);
    await waitFor(() => expect(c.getPrReview).toHaveBeenCalledWith(first.featureId));
    view.rerender(<ApiProvider value={c as ApiClient}><ReviewBoardPage featureId={second.featureId} /></ApiProvider>);
    await openDetails();
    await screen.findByText('Current project', { selector: 'summary span' });
    const older = review(first.featureId, 'sha-first');
    older.changeGraph.projects = [{ id: 'old', name: 'Obsolete project', path: 'old.proj' }];
    older.changeGraph.nodes = [{ ...newer.changeGraph.nodes[0], projectId: 'old', path: 'old.ts' }];
    await act(async () => pending.resolve(older));
    expect(screen.queryByText('Obsolete project')).not.toBeInTheDocument();
    expect(screen.getByText('Current project', { selector: 'summary span' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View 0 changed files' }));
    expect(screen.getByRole('dialog', { name: 'Diff for Changed files' })).toBeInTheDocument();
    view.rerender(<ApiProvider value={c as ApiClient}><ReviewBoardPage featureId={first.featureId} /></ApiProvider>);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Diff for Changed files' })).not.toBeInTheDocument());
  });
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
    await openDetails();
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
    await openDetails();
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

  it('posts only after confirmation and preserves open disposition independently of publication', async () => {
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
    const action = await screen.findByRole('button', { name: 'Leave a comment' });
    await waitFor(() => expect(action).toBeEnabled());
    fireEvent.click(action);
    expect(screen.getByRole('dialog', { name: 'Leave a comment' })).toBeInTheDocument();
    expect(c.addPrReviewComment).not.toHaveBeenCalled();
    expect(reviewBoardRunStore.getState(value.featureId).resolutions[finding.id]).toBeUndefined();
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'My edited comment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Leave comment' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Leave a comment' })).toBeNull());
    expect(c.addPrReviewComment).toHaveBeenCalledOnce();
    expect(c.addPrReviewComment).toHaveBeenCalledWith(value.featureId, {
      path: 'src/buffer.cpp', line: 20, body: 'My edited comment', expectedHeadSha: 'sha-a',
    });
    expect(reviewBoardRunStore.getState(value.featureId).resolutions[finding.id]).toBeUndefined();
    expect(reviewBoardRunStore.getState(value.featureId).publications[finding.id]).toBe('posted');
    expect(screen.getByText('Posted · still requires review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave a comment' })).toBeDisabled();
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
    const action = await screen.findByRole('button', { name: 'Leave a comment' });
    await waitFor(() => expect(action).toBeEnabled());
    fireEvent.click(action);
    fireEvent.click(screen.getByRole('checkbox', { name: /This older finding/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave comment' }));
    if (transition === 'switch') {
      root.rerender(<ApiProvider value={c as ApiClient}><ReviewBoardPage featureId={replacementId} /></ApiProvider>);
    } else {
      fireEvent(window, new Event('focus'));
    }
    await screen.findByText('Replacement finding');
    pending.resolve({ id: 't1', path: 'src/a.ts', line: 20, status: 'active', comments: [] });
    if (transition === 'refresh') await screen.findByText(/Comment posted, but the review changed/);
    else await waitFor(() => expect(reviewBoardRunStore.getState(featureId).publications['security/ai-0']).toBe('posted'));
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
    await openDetails();
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
    await openDetails();
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

    await openDetails();
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
    await openDetails();
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

    await openDetails();
    await screen.findByText('Security', { selector: 'h3' });
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
