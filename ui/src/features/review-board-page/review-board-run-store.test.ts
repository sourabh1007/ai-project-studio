import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewBoard, ReviewBoardPerspectiveEvent } from '../../lib/types.js';
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
    getPrReview: vi.fn().mockResolvedValue({ changeGraph: { status: 'ready' } }),
    analyzeReviewBoardPerspective: vi.fn(),
    analyzeReviewBoardPerspectives: vi.fn(async (_id: string, _emit: (event: ReviewBoardPerspectiveEvent) => void) => {}),
    pullLatestPrReview: vi.fn(),
  };
}

describe('live same-run snapshots', () => {
  async function runningReview() {
    const saved = board('live-snapshot', 'sha');
    saved.perspectives.push({ ...saved.perspectives[0], id: 'testing', name: 'Testing' });
    saved.run = { id: 'live-run', revision: 1, status: 'running', options: {}, providerId: 'cli', model: 'auto',
      perspectiveIds: ['security', 'testing'], headSha: 'sha', graphGeneratedAt: 'graph', startedAt: '2026-01-01',
      failures: {}, context: { fingerprint: 'context', skills: [], businessRequirements: '', evidence: '', warnings: [] } };
    const c = api(vi.fn(async () => structuredClone(saved)));
    const end = deferred<void>();
    const started = deferred<void>();
    let send!: (event: ReviewBoardPerspectiveEvent) => void;
    c.analyzeReviewBoardPerspectives.mockImplementation(async (_id, emit) => {
      send = emit;
      started.resolve();
      await end.promise;
    });
    const store = createReviewBoardRunStore();
    const run = store.analyze(saved.featureId, c, { waitForGraph: false });
    await started.promise;
    c.getReviewBoard.mockClear();
    return { saved, c, store, send, end, run };
  }

  it('coalesces reads and displays saved narratives while preserving progress, clocks and human decisions', async () => {
    const { saved, c, store, send, end, run } = await runningReview();
    send({ type: 'analyzing', perspectiveId: 'testing' });
    const before = store.getState(saved.featureId);
    const snapshot = deferred<ReviewBoard>();
    c.getReviewBoard.mockReturnValueOnce(snapshot.promise);
    const first = store.refreshLive(saved.featureId, c);
    const second = store.refreshLive(saved.featureId, c);
    expect(c.getReviewBoard).toHaveBeenCalledOnce();
    snapshot.resolve({ ...saved, run: { ...saved.run!, revision: 2 }, problem: 'Retries duplicate a charge.',
      solution: 'Reuse the operation key.\n\n```text\n[Retry] -> [Original receipt]\n```' });
    await Promise.all([first, second]);
    const current = store.getState(saved.featureId);
    expect(current.board?.solution).toContain('[Retry] -> [Original receipt]');
    expect(current.board?.problem).toBe('Retries duplicate a charge.');
    expect(current.running).toBe(true);
    expect(current.progress).toBe(before.progress);
    expect(current.timing).toBe(before.timing);
    expect(current.preparationTiming).toBe(before.preparationTiming);
    expect(current.signoff).toBe(before.signoff);
    expect(current.resolutions).toBe(before.resolutions);
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce();
    expect(c.analyzeReviewBoardPerspective).not.toHaveBeenCalled();
    end.resolve(); await run;
  });

  it('does not let a slower snapshot erase a newer streamed finding or earlier available analysis', async () => {
    const { saved, c, store, send, end, run } = await runningReview();
    const result = {
      perspectiveId: 'security', runId: 'live-run', skipped: false, skipReason: null, summary: 'Inspected retries',
      rationale: [], checks: [],
      perspective: { ...saved.perspectives[0], findings: [{
        id: 'security/retry', perspectiveId: 'security', title: 'Retry duplicates the charge',
        detail: 'Reuse an operation key.', severity: 'medium' as const, status: 'warning' as const, evidence: [],
      }] },
    };
    const delayed = deferred<ReviewBoard>();
    c.getReviewBoard.mockReturnValueOnce(delayed.promise);
    const refresh = store.refreshLive(saved.featureId, c);
    send({ type: 'analyzed', analysis: result });
    delayed.resolve({ ...saved, solution: 'Use idempotency.', uniqueFindings: [] });
    await refresh;
    expect(store.getState(saved.featureId).board?.perspectives[0].findings).toEqual(result.perspective.findings);
    expect(store.getState(saved.featureId).board?.uniqueFindings).toBeUndefined();
    expect(store.getState(saved.featureId).progress.security.status).toBe('done');
    await store.refreshLive(saved.featureId, c);
    expect(store.getState(saved.featureId).board?.analyses?.security).toBe(result);
    end.resolve(); await run;
  });

  it.each(['run', 'head', 'graph', 'revision', 'review timestamp', 'perspectives'] as const)(
    'rejects a live snapshot with a different or stale %s',
    async (change) => {
      const { saved, c, store, end, run } = await runningReview();
      const stale = structuredClone(saved);
      stale.solution = 'Do not display this stale explanation.';
      if (change === 'run') stale.run!.id = 'another-run';
      if (change === 'head') stale.pull.headSha = 'another-head';
      if (change === 'graph') stale.run!.graphGeneratedAt = 'another-graph';
      if (change === 'revision') stale.run!.revision = 0;
      if (change === 'review timestamp') stale.reviewUpdatedAt = 'another-review';
      if (change === 'perspectives') stale.perspectives[1].id = 'another-perspective';
      const before = store.getState(saved.featureId);
      c.getReviewBoard.mockResolvedValueOnce(stale);
      await store.refreshLive(saved.featureId, c);
      expect(store.getState(saved.featureId)).toBe(before);
      end.resolve(); await run;
    },
  );

  it('keeps live results on a failed read, retries on the next refresh, and ignores a reply after reset', async () => {
    const { saved, c, store, end, run } = await runningReview();
    const before = store.getState(saved.featureId);
    c.getReviewBoard.mockRejectedValueOnce(new Error('Temporarily offline'));
    await store.refreshLive(saved.featureId, c);
    expect(store.getState(saved.featureId)).toBe(before);
    c.getReviewBoard.mockResolvedValueOnce({ ...saved, solution: 'Recovered explanation.' });
    await store.refreshLive(saved.featureId, c);
    expect(store.getState(saved.featureId).board?.solution).toBe('Recovered explanation.');
    const delayed = deferred<ReviewBoard>();
    c.getReviewBoard.mockReturnValueOnce(delayed.promise);
    const refresh = store.refreshLive(saved.featureId, c);
    store.reset(saved.featureId, c);
    delayed.resolve({ ...saved, solution: 'Old cancelled explanation.' });
    await refresh;
    expect(store.getState(saved.featureId).board?.solution).not.toBe('Old cancelled explanation.');
    end.resolve(); await run;
  });
});

describe('automatic bulk review scheduling and timing', () => {
  it('retains missing stream-result errors after reloading a newer revision of the same run', async () => {
    let saved = board('stream-gap', 'sha');
    saved.perspectives.push({ ...saved.perspectives[0], id: 'testing', name: 'Testing' });
    saved.run = { id: 'r', revision: 1, status: 'running', options: {}, providerId: 'cli', model: 'auto',
      perspectiveIds: ['security', 'testing'], headSha: 'sha', graphGeneratedAt: 'graph', startedAt: '2026-01-01',
      failures: {}, context: { fingerprint: 'context', skills: [], businessRequirements: '', evidence: '', warnings: [] } };
    const c = api(vi.fn(async () => structuredClone(saved)));
    c.analyzeReviewBoardPerspectives.mockImplementation(async (_id, emit) => {
      const result = { perspectiveId: 'security', perspective: saved.perspectives[0], runId: 'r',
        skipped: false, skipReason: null, summary: 'Inspected security', rationale: [], checks: [] };
      saved = { ...saved, run: { ...saved.run!, revision: 2 }, analyses: { security: result } };
      emit({ type: 'analyzed', analysis: result });
    });
    const store = createReviewBoardRunStore();
    await store.analyze(saved.featureId, c);
    expect(store.getState(saved.featureId).progress.testing).toMatchObject({
      status: 'error', error: 'The review stream ended without a result for this perspective. Retry the review.',
    });
    expect(store.getState(saved.featureId).progress.security.status).toBe('done');
    await store.load(saved.featureId, c, true);
    expect(store.getState(saved.featureId).progress).toEqual({});
    expect(store.getState(saved.featureId).board?.analyses?.security.summary).toBe('Inspected security');
  });
  it('does not let perspective retries cancel a full review that is still preparing', async () => {
    const saved = board('preparing-retry', 'sha');
    saved.run = { id: 'r', revision: 1, status: 'failed', options: {}, providerId: 'cli', model: 'auto',
      perspectiveIds: ['security'], headSha: 'sha', graphGeneratedAt: 'graph', startedAt: '2026-01-01',
      failures: { security: 'Failed' }, context: { fingerprint: 'context', skills: [], businessRequirements: '', evidence: '', warnings: [] } };
    const c = api(vi.fn(async () => structuredClone(saved)));
    const ready = deferred<{ changeGraph: { status: string } }>();
    c.getPrReview.mockReturnValue(ready.promise);
    c.analyzeReviewBoardPerspective.mockResolvedValue({ perspectiveId: 'security',
      perspective: saved.perspectives[0], skipped: false, skipReason: null, summary: null, rationale: [], checks: [] });
    const store = createReviewBoardRunStore();
    await store.load(saved.featureId, c);
    const full = store.analyze(saved.featureId, c);
    const retry = store.retryFailed(saved.featureId, c);
    const single = store.analyzeOne(saved.featureId, 'security', c);
    ready.resolve({ changeGraph: { status: 'ready' } });
    await Promise.all([full, retry, single]);
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce();
    expect(c.analyzeReviewBoardPerspective).not.toHaveBeenCalled();
  });
  it('resumes a saved failed review through the authoritative stream and reloads its completed run', async () => {
    let saved = board('resume-saved', 'sha');
    saved.run = { id: 'r', revision: 1, status: 'failed', options: {}, providerId: 'cli', model: 'auto',
      perspectiveIds: ['security'], headSha: 'sha', graphGeneratedAt: 'graph', startedAt: '2026-01-01',
      failures: { security: 'Failed' }, context: { fingerprint: 'context', skills: [], businessRequirements: '', evidence: '', warnings: [] } };
    const c = api(vi.fn(async () => structuredClone(saved)));
    c.analyzeReviewBoardPerspectives.mockImplementation(async (_id, emit) => {
      const result = { perspectiveId: 'security', perspective: saved.perspectives[0], runId: 'r',
        skipped: false, skipReason: null, summary: 'Inspected security', rationale: [], checks: [] };
      saved = { ...saved, run: { ...saved.run!, revision: 2, status: 'completed', failures: {} }, analyses: { security: result } };
      emit({ type: 'analyzed', analysis: result });
    });
    const store = createReviewBoardRunStore();
    await store.load(saved.featureId, c);
    await store.retryFailed(saved.featureId, c);
    expect(c.analyzeReviewBoardPerspective).not.toHaveBeenCalled();
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce();
    expect(store.getState(saved.featureId).board?.run?.status).toBe('completed');
    expect(store.getState(saved.featureId).board?.analyses?.security.summary).toBe('Inspected security');
  });
  it('prepares saved options only after refreshed change evidence and reloads after the stream', async () => {
    const store = createReviewBoardRunStore();
    const calls: string[] = [];
    const value = board('fresh', 'sha');
    const c = {
      ...api(vi.fn(async () => { calls.push('board'); return value; })),
      pullLatestPrReview: vi.fn(async () => { calls.push('pull'); return {} as never; }),
      getPrReview: vi.fn(async () => { calls.push('graph'); return { changeGraph: { status: 'ready' } } as never; }),
      configureReviewBoard: vi.fn(async () => { calls.push('options'); return value; }),
      analyzeReviewBoardPerspectives: vi.fn(async (_id: string, emit: (event: ReviewBoardPerspectiveEvent) => void) => {
        calls.push('stream');
        emit({ type: 'analyzed', analysis: {
          perspectiveId: 'security', perspective: value.perspectives[0], skipped: false, skipReason: null,
          summary: null, rationale: [], checks: [],
        } });
      }),
    };
    const options = { model: 'named', businessContext: 'Keep existing behavior.' };
    await store.analyze('fresh', c, { takeLatest: true, fresh: true, reviewOptions: options });
    expect(calls).toEqual(['pull', 'graph', 'options', 'board', 'stream', 'board']);
    expect(c.configureReviewBoard).toHaveBeenCalledWith('fresh', options);
  });

  it('keeps preparation visible and timed through context collection and authoritative reload', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const store = createReviewBoardRunStore();
    const value = board('context-progress', 'sha');
    const prepared = deferred<ReviewBoard>();
    const loaded = deferred<ReviewBoard>();
    const c = { ...api(vi.fn().mockResolvedValue(value)), configureReviewBoard: vi.fn(() => prepared.promise) };
    await store.load(value.featureId, c);
    c.getPrReview.mockImplementation(async () => {
      now.mockReturnValue(2000);
      return { changeGraph: { status: 'ready' } };
    });
    const running = store.analyze(value.featureId, c, { fresh: true });
    await flush();
    expect(store.getState(value.featureId).prep).toMatchObject({ active: true, message: expect.stringMatching(/context/i) });
    expect(store.getState(value.featureId).board).toEqual(value);
    expect(c.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
    await store.retryFailed(value.featureId, c);
    await store.analyzeOne(value.featureId, 'security', c);
    expect(c.analyzeReviewBoardPerspective).not.toHaveBeenCalled();
    c.getReviewBoard.mockReturnValueOnce(loaded.promise);
    now.mockReturnValue(3000);
    prepared.resolve(value);
    await flush();
    expect(store.getState(value.featureId).prep.active).toBe(true);
    now.mockReturnValue(4000);
    loaded.resolve(value);
    await running;
    expect(store.getState(value.featureId).prep.active).toBe(false);
    expect(store.getState(value.featureId).preparationTiming).toEqual({ startedAt: 1000, finishedAt: 4000 });
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce();
    now.mockRestore();
  });

  it('preserves the prior board and exposes stale-evidence preparation failures without starting inference', async () => {
    const store = createReviewBoardRunStore();
    const value = board('context-stale', 'old-sha');
    const c = { ...api(vi.fn().mockResolvedValue(value)), configureReviewBoard: vi.fn().mockRejectedValue(
      new Error('The remote head changed. Pull the latest evidence before reviewing.')) };
    await store.load(value.featureId, c);
    await store.analyze(value.featureId, c, { fresh: true });
    expect(store.getState(value.featureId)).toMatchObject({
      board: value, running: false, prep: { active: false, error: 'The remote head changed. Pull the latest evidence before reviewing.' },
    });
    expect(c.pullLatestPrReview).not.toHaveBeenCalled();
    expect(c.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
  });

  it('persists publication independently from disposition and keeps the dismissal reason', () => {
    window.localStorage.clear();
    const store = createReviewBoardRunStore();
    store.setFindingPublication('publication', 'finding', 'posted');
    expect(store.getState('publication').resolutions.finding).toBeUndefined();
    store.setFindingResolution('publication', 'finding', 'ignored', 'Not reachable from the changed path.');
    const restored = createReviewBoardRunStore().getState('publication');
    expect(restored.publications.finding).toBe('posted');
    expect(restored.resolutions.finding).toBe('ignored');
    expect(restored.resolutionReasons.finding).toBe('Not reachable from the changed path.');
    store.setFindingResolution('publication', 'finding', null);
    expect(store.getState('publication').publications.finding).toBe('posted');
    expect(store.getState('publication').resolutionReasons.finding).toBeUndefined();
    window.localStorage.clear();
  });

  it('recovers interrupted change evidence once before automatic analysis, then settles durable intent', async () => {
    const store = createReviewBoardRunStore();
    const c = {
      ...client(),
      retryPrReviewStep: vi.fn().mockResolvedValue({}),
      settleReviewBoardQueue: vi.fn().mockResolvedValue({ settled: true }),
    };
    c.getPrReview.mockResolvedValueOnce({ changeGraph: { status: 'failed', failure: {
      message: 'Background analysis cancelled during app shutdown.',
    } } });
    c.analyzeReviewBoardPerspectives.mockImplementation(async (_id, emit) => {
      expect(c.retryPrReviewStep).toHaveBeenCalledWith('one', 'changeGraph');
      emit({ type: 'analyzed', analysis: {
        perspectiveId: 'security', perspective: board('one', 'sha').perspectives[0],
        skipped: false, skipReason: null, summary: 'Reviewed', rationale: [], checks: [],
      } });
    });
    await store.analyze('one', c);
    expect(c.getPrReview).toHaveBeenCalledTimes(2);
    expect(c.retryPrReviewStep).toHaveBeenCalledTimes(1);
    expect(c.settleReviewBoardQueue).toHaveBeenCalledWith('one');
    expect(store.getState('one').progress.security.status).toBe('done');
  });
  it('does not loop on repeated shutdown failures or start analysis on failed evidence', async () => {
    const store = createReviewBoardRunStore();
    const c = { ...client(), retryPrReviewStep: vi.fn().mockResolvedValue({}) };
    c.getPrReview.mockResolvedValue({ changeGraph: { status: 'failed', failure: {
      message: 'Interrupted by a restart before it finished. Retry to regenerate.',
    } } });
    await store.analyze('one', c);
    expect(c.retryPrReviewStep).toHaveBeenCalledTimes(1);
    expect(c.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
    expect(store.getState('one').prep.error).toContain('Interrupted by a restart');
  });
  it('maps a whole-stream failure to real perspectives without inventing an eighth perspective', async () => {
    const store = createReviewBoardRunStore();
    const c = client();
    c.analyzeReviewBoardPerspectives.mockImplementation(async (_id, emit) => {
      emit({ type: 'failed', perspectiveId: '', error: 'Change graph cancelled during shutdown' });
    });
    await store.analyze('one', c);
    expect(Object.keys(store.getState('one').progress)).toEqual(['security']);
    expect(store.getState('one').progress.security.error).toBe('Change graph cancelled during shutdown');
    expect(store.getState('one').progress.security.attempt).toBe(0);
  });
  it('surfaces durable queue write errors and makes reset cancel saved import intent', async () => {
    const store = createReviewBoardRunStore();
    const c = { ...client(), settleReviewBoardQueue: vi.fn().mockRejectedValue(new Error('Queue save failed')) };
    await store.analyze('one', c);
    expect(store.getState('one').prep.error).toBe('Queue save failed');
    store.reset('one', c);
    await flush();
    expect(c.settleReviewBoardQueue).toHaveBeenCalledTimes(2);
    expect(store.getState('one').prep.error).toBe('Queue save failed');
  });
  afterEach(() => vi.restoreAllMocks());
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  function client() {
    const result = api(vi.fn(async (id: string) => board(id, 'sha')));
    result.getPrReview.mockResolvedValue({ changeGraph: { status: 'ready' } });
    return result;
  }
  it('does not reschedule an attempted review after a read invalidates its old evidence', async () => {
    const store = createReviewBoardRunStore();
    const c = client();
    store.enqueueBulk(['opened'], c);
    await flush();
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce();
    c.getReviewBoard.mockResolvedValue(board('opened', 'new-head'));
    await store.load('opened', c);
    expect(store.getState('opened').analyzed).toBe(false);
    store.enqueueBulk(['opened'], c);
    await flush();
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce();
    store.enqueueBulk(['opened'], c, { retry: true });
    await flush();
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledTimes(2);
  });

  it('does not reload a board when opening its queued or preparing run', async () => {
    const store = createReviewBoardRunStore();
    const c = client();
    const graph = deferred<{ changeGraph: { status: string } }>();
    c.getPrReview.mockReturnValue(graph.promise);
    store.enqueueBulk(['one', 'two', 'three', 'queued'], c);
    await store.load('one', c);
    await store.load('queued', c);
    expect(c.getReviewBoard).not.toHaveBeenCalled();
    graph.resolve({ changeGraph: { status: 'ready' } });
    await flush();
  });

  it('retries incomplete perspectives without repeating successful sections', async () => {
    const store = createReviewBoardRunStore();
    const value = board('incomplete', 'sha');
    value.perspectives.push({ ...value.perspectives[0], id: 'testing', name: 'Testing' });
    const c = client();
    c.getReviewBoard.mockResolvedValue(value);
    c.analyzeReviewBoardPerspectives.mockImplementation(async (_id, emit) => {
      for (const perspective of value.perspectives) emit({ type: 'analyzed', analysis: {
        perspectiveId: perspective.id, perspective, skipped: perspective.id === 'testing',
        skipReason: perspective.id === 'testing' ? 'Unavailable' : null,
        summary: 'Reviewed', rationale: [], checks: [],
      } });
    });
    c.analyzeReviewBoardPerspective.mockResolvedValue({
      perspectiveId: 'testing', perspective: value.perspectives[1],
      skipped: false, skipReason: null, summary: 'Reviewed', rationale: [], checks: [],
    });
    await store.analyze(value.featureId, c);
    await store.retryFailed(value.featureId, c, { includeIncomplete: true });
    expect(c.analyzeReviewBoardPerspective).toHaveBeenCalledOnce();
    expect(c.analyzeReviewBoardPerspective).toHaveBeenCalledWith(
      value.featureId, 'testing', expect.any(AbortSignal));
    expect(store.getState(value.featureId).progress.security.status).toBe('done');
    expect(store.getState(value.featureId).progress.testing.status).toBe('done');
  });
  it('globally bounds automatic runs, deduplicates imports and keeps draining without subscribers', async () => {
    const store = createReviewBoardRunStore();
    const c = client();
    const streams = new Map<string, ReturnType<typeof deferred<void>>>();
    c.analyzeReviewBoardPerspectives.mockImplementation(async (id) => {
      const stream = deferred<void>(); streams.set(id, stream); await stream.promise;
    });
    const unsubscribe = store.subscribe('four', vi.fn());
    store.enqueueBulk(['one', 'two', 'three', 'four'], c);
    await flush();
    expect([...streams.keys()]).toEqual(['one', 'two', 'three']);
    expect(store.getState('four')).toMatchObject({ queued: true, timing: null });
    store.enqueueBulk(['one', 'four', 'five'], c);
    unsubscribe();
    streams.get('one')!.resolve();
    await flush();
    expect([...streams.keys()]).toEqual(['one', 'two', 'three', 'four']);
    store.enqueueBulk(['one'], c);
    for (const stream of streams.values()) stream.resolve();
    await flush();
    expect(streams.has('five')).toBe(true);
    streams.get('five')!.resolve();
    await flush();
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledTimes(5);
    expect(store.getState('five')).toMatchObject({ queued: false, running: false, analyzed: true });
  });
  it('continues after preparation failure, and retries failed reviews only when explicitly requested', async () => {
    const store = createReviewBoardRunStore();
    const c = client();
    c.getPrReview.mockResolvedValueOnce({ changeGraph: { status: 'failed', failure: { message: 'No evidence' } } });
    store.enqueueBulk(['failed', 'two', 'three', 'four'], c);
    await flush();
    expect(store.getState('failed').prep.error).toBe('No evidence');
    expect(store.getState('failed').timing?.finishedAt).not.toBeNull();
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledTimes(3);
    store.enqueueBulk(['failed'], c);
    await flush();
    expect(c.getPrReview).toHaveBeenCalledTimes(4);
    store.enqueueBulk(['failed'], c, { retry: true });
    await flush();
    expect(c.getPrReview).toHaveBeenCalledTimes(5);
    expect(store.getState('failed').prep.error).toBeNull();
  });
  it('removes reset reviews from the pending queue', async () => {
    const store = createReviewBoardRunStore();
    const c = client();
    const end = deferred<void>();
    c.analyzeReviewBoardPerspectives.mockImplementation(async () => end.promise);
    store.enqueueBulk(['one', 'two', 'three', 'reset'], c);
    await flush();
    store.reset('reset', c);
    end.resolve();
    await flush();
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledTimes(3);
    expect(store.getState('reset')).toMatchObject({ queued: false, timing: null });
  });
  it('releases admission slots after an unexpected rejection', async () => {
    const store = createReviewBoardRunStore();
    const analyze = vi.spyOn(store, 'analyze').mockRejectedValue(new Error('Unexpected failure'));
    store.enqueueBulk(['one', 'two', 'three', 'four'], client());
    await flush();
    expect(analyze).toHaveBeenCalledTimes(4);
    expect(store.getState('four')).toMatchObject({ queued: false, prep: { error: 'Unexpected failure' } });
  });
  it('times preparation plus analysis, preserves duration on normal reload and clears it for changed evidence', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const store = createReviewBoardRunStore();
    const c = client();
    const graph = deferred<{ changeGraph: { status: string } }>();
    const end = deferred<void>();
    c.getPrReview.mockImplementation(() => graph.promise);
    c.analyzeReviewBoardPerspectives.mockImplementation(async () => end.promise);
    const run = store.analyze('timed', c, { waitForGraph: true });
    expect(store.getState('timed').timing).toEqual({ startedAt: 1000, finishedAt: null });
    now.mockReturnValue(6000);
    graph.resolve({ changeGraph: { status: 'ready' } });
    await flush();
    now.mockReturnValue(9000);
    end.resolve(); await run;
    expect(store.getState('timed').timing).toEqual({ startedAt: 1000, finishedAt: 9000 });
    expect(store.getState('timed').preparationTiming).toEqual({ startedAt: 1000, finishedAt: 6000 });
    await store.load('timed', c);
    expect(store.getState('timed').timing?.finishedAt).toBe(9000);
    c.getReviewBoard.mockResolvedValue(board('timed', 'changed'));
    await store.load('timed', c);
    expect(store.getState('timed').timing).toBeNull();
    expect(store.getState('timed').preparationTiming).toBeNull();
  });
  it('does not restore a cancelled attempt timer after resetting an active run', async () => {
    const store = createReviewBoardRunStore();
    const c = client();
    const end = deferred<void>();
    c.analyzeReviewBoardPerspectives.mockImplementation(async () => end.promise);
    const run = store.analyze('reset-active', c);
    await flush();
    store.reset('reset-active', c);
    end.resolve(); await run;
    expect(store.getState('reset-active').timing).toBeNull();
  });

  it('times each streamed perspective from actual execution, freezes it on completion and starts fresh for a rerun', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const store = createReviewBoardRunStore();
    const c = client();
    let send!: (event: ReviewBoardPerspectiveEvent) => void;
    const end = deferred<void>();
    c.analyzeReviewBoardPerspectives.mockImplementation(async (_id, emit) => { send = emit; await end.promise; });
    const run = store.analyze('section', c);
    await flush();
    expect(store.getState('section').progress.security.timing).toBeUndefined();
    now.mockReturnValue(4000);
    send({ type: 'analyzing', perspectiveId: 'security' });
    expect(store.getState('section').progress.security.timing).toEqual({ startedAt: 4000, finishedAt: null });
    now.mockReturnValue(9000);
    send({ type: 'analyzed', analysis: {
      perspectiveId: 'security', perspective: board('section', 'sha').perspectives[0], skipped: false,
      skipReason: null, summary: 'Checked', rationale: [], checks: [],
    } });
    now.mockReturnValue(12_000);
    end.resolve(); await run;
    expect(store.getState('section').progress.security.timing).toEqual({ startedAt: 4000, finishedAt: 9000 });
    await store.load('section', c);
    expect(store.getState('section').progress.security.timing?.finishedAt).toBe(9000);
    const one = deferred<unknown>();
    c.analyzeReviewBoardPerspective.mockImplementation(() => one.promise);
    const rerun = store.analyzeOne('section', 'security', c);
    await flush();
    expect(store.getState('section').progress.security.timing?.startedAt).toBe(12_000);
    now.mockReturnValue(15_000);
    one.resolve({ perspective: board('section', 'sha').perspectives[0], skipped: true, skipReason: 'No evidence', summary: '', rationale: [], checks: [] });
    await rerun;
    expect(store.getState('section').progress.security).toMatchObject({
      status: 'skipped', timing: { startedAt: 12_000, finishedAt: 15_000 },
    });
  });

  it('freezes unfinished section clocks when a stream fails and restarts them on retry', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const store = createReviewBoardRunStore();
    const c = client();
    c.analyzeReviewBoardPerspectives.mockImplementation(async (_id, emit) => {
      emit({ type: 'analyzing', perspectiveId: 'security' });
      now.mockReturnValue(3000);
      throw new Error('Stream lost');
    });
    await store.analyze('section-error', c);
    expect(store.getState('section-error').progress.security).toMatchObject({
      status: 'error', timing: { startedAt: 1000, finishedAt: 3000 },
    });
    now.mockReturnValue(5000);
    c.analyzeReviewBoardPerspective.mockImplementation(async () => {
      now.mockReturnValue(7000);
      return { perspective: board('section-error', 'sha').perspectives[0], skipped: false, skipReason: null, summary: '', rationale: [], checks: [] };
    });
    await store.retryFailed('section-error', c);
    expect(store.getState('section-error').progress.security).toMatchObject({
      status: 'done', timing: { startedAt: 5000, finishedAt: 7000 },
    });
  });

  it('removes deleted features from the queue and ignores late active stream events', async () => {
    const store = createReviewBoardRunStore();
    const c = client();
    const end = deferred<void>();
    const events = new Map<string, (event: ReviewBoardPerspectiveEvent) => void>();
    c.analyzeReviewBoardPerspectives.mockImplementation(async (id, emit) => { events.set(id, emit); await end.promise; });
    store.enqueueBulk(['active', 'two', 'three', 'queued'], c);
    await flush();
    store.remove('active'); store.remove('queued');
    events.get('active')!({ type: 'analyzing', perspectiveId: 'security' });
    end.resolve(); await flush();
    store.enqueueBulk(['active', 'queued'], c, { retry: true });
    await flush();
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledTimes(3);
    expect(store.getState('active')).toMatchObject({ board: null, progress: {}, timing: null, queued: false, running: false });
    expect(store.getState('queued').queued).toBe(false);
  });
  it('freezes cancelled single-section and retry clocks rather than leaving a permanent running state', async () => {
    const store = createReviewBoardRunStore();
    const c = client();
    await store.load('cancel-section', c);
    c.analyzeReviewBoardPerspective.mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    await store.analyzeOne('cancel-section', 'security', c);
    expect(store.getState('cancel-section')).toMatchObject({
      running: false, progress: { security: { status: 'error', error: 'Review cancelled before this perspective completed.' } },
    });
    expect(store.getState('cancel-section').progress.security.timing?.finishedAt).not.toBeNull();
    await store.retryFailed('cancel-section', c);
    expect(store.getState('cancel-section').running).toBe(false);
    expect(store.getState('cancel-section').progress.security.timing?.finishedAt).not.toBeNull();
  });
  it('does not launch analysis after reset during board loading', async () => {
    const store = createReviewBoardRunStore();
    const c = client();
    const request = deferred<ReviewBoard>();
    c.getReviewBoard.mockImplementation(() => request.promise);
    const run = store.analyze('reset-loading', c);
    store.reset('reset-loading', c);
    request.resolve(board('reset-loading', 'sha'));
    await run;
    expect(c.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
    expect(store.getState('reset-loading')).toMatchObject({ running: false, timing: null, analyzed: false });
  });
});

describe('review-board-run-store approval identity', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('restores persisted machine results after an app restart without starting a review', async () => {
    const initial = board('restored', 'sha');
    initial.analyses = {
      security: {
        perspectiveId: 'security', perspective: initial.perspectives[0],
        skipped: false, skipReason: null, summary: 'Persisted review result', rationale: [], checks: [],
      },
    };
    const c = api(vi.fn().mockResolvedValue(initial));
    const store = createReviewBoardRunStore();
    await store.load(initial.featureId, c);
    expect(store.getState(initial.featureId)).toMatchObject({
      analyzed: true, running: false, progress: { security: { status: 'done', checked: 'Persisted review result' } },
    });
    store.enqueueBulk([initial.featureId], c);
    expect(c.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
    store.reset(initial.featureId, c);
    await store.load(initial.featureId, c, true);
    expect(store.getState(initial.featureId).analyzed).toBe(false);
  });

  it('restores saved failures, retries only failed lenses and clears errors when a new run replaces them', async () => {
    const initial = board('saved-failures', 'sha');
    initial.perspectives.push({ ...initial.perspectives[0], id: 'testing', name: 'Testing' });
    initial.run = {
      id: 'saved-run', revision: 1, status: 'failed', options: { model: 'auto' },
      providerId: 'cli', model: 'auto', perspectiveIds: ['security', 'testing'],
      context: { fingerprint: 'context', skills: [], businessRequirements: '', evidence: 'diff', warnings: [] },
      headSha: 'sha', graphGeneratedAt: 'graph', startedAt: '2026-01-01',
      failures: { security: 'Native engine startup failed', retired: 'Old perspective failure' },
    };
    const testing = {
      perspectiveId: 'testing', perspective: initial.perspectives[1], runId: 'saved-run',
      skipped: false, skipReason: null, summary: 'Reviewed tests', rationale: [], checks: [],
    };
    initial.analyses = { testing };
    const c = api(vi.fn().mockResolvedValue(initial));
    const store = createReviewBoardRunStore();
    await store.load(initial.featureId, c);
    await store.load(initial.featureId, c);
    expect(store.getState(initial.featureId).progress).toMatchObject({
      security: { status: 'error', error: 'Native engine startup failed' },
      testing: { status: 'done' },
    });
    expect(store.getState(initial.featureId).progress.retired).toBeUndefined();
    expect(c.analyzeReviewBoardPerspective).not.toHaveBeenCalled();
    expect(c.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
    c.analyzeReviewBoardPerspectives.mockImplementation(async (_id, emit) => {
      const analysis = { ...testing, perspectiveId: 'security', perspective: initial.perspectives[0] };
      initial.run = { ...initial.run!, status: 'completed', revision: 2, failures: {} };
      initial.analyses = { testing, security: analysis };
      emit({ type: 'analyzed', analysis });
      emit({ type: 'analyzed', analysis: testing });
    });
    await store.retryFailed(initial.featureId, c);
    expect(c.analyzeReviewBoardPerspective).not.toHaveBeenCalled();
    expect(c.analyzeReviewBoardPerspectives).toHaveBeenCalledOnce();
    expect(store.getState(initial.featureId).progress).toMatchObject({
      security: { status: 'done', error: null }, testing: { status: 'done' },
    });
    initial.run = { ...initial.run!, id: 'new-run', status: 'prepared', revision: 1 };
    await store.load(initial.featureId, c);
    expect(store.getState(initial.featureId).progress).toEqual({});
  });

  it('preserves actual same-revision results when another tab reloads the blank board', async () => {
    const featureId = 'same-revision';
    const initial = board(featureId, 'sha');
    initial.perspectives[0].status = 'not-started';
    const client = api(vi.fn().mockResolvedValue(initial));
    const result = { ...initial.perspectives[0], status: 'approved' as const };
    client.analyzeReviewBoardPerspectives = vi.fn(async (_id, emit) => {
      emit({ type: 'analyzed', analysis: {
        perspectiveId: 'security', perspective: result, skipped: false,
        skipReason: null, summary: 'Inspected authorization changes', rationale: [], checks: [],
      } });
    });
    const store = createReviewBoardRunStore();
    await store.analyze(featureId, client);
    await store.load(featureId, client);
    expect(store.getState(featureId).board?.perspectives[0].status).toBe('approved');
    expect(store.getState(featureId).progress.security.status).toBe('done');
    expect(store.getState(featureId).progress.security.checked).toContain('authorization');
    await store.load(featureId, client, true);
    expect(store.getState(featureId).analyzed).toBe(false);
    expect(store.getState(featureId).progress).toEqual({});
    expect(store.getState(featureId).board?.perspectives[0].status).toBe('not-started');
  });

  it('clears completion when the evidence or discovered perspective set changes', async () => {
    const featureId = 'changed-evidence';
    const initial = board(featureId, 'sha');
    const client = api(vi.fn().mockResolvedValue(initial));
    const store = createReviewBoardRunStore();
    await store.analyze(featureId, client);
    expect(store.getState(featureId).analyzed).toBe(true);
    client.getReviewBoard.mockResolvedValue({
      ...initial,
      perspectives: [...initial.perspectives, { ...initial.perspectives[0], id: 'testing' }],
    });
    await store.load(featureId, client);
    expect(store.getState(featureId).analyzed).toBe(false);
    expect(store.getState(featureId).progress).toEqual({});
  });

  it('marks a stream that ends without results as failed, not completed', async () => {
    const featureId = 'empty-stream';
    const client = api(vi.fn().mockResolvedValue(board(featureId, 'sha')));
    const store = createReviewBoardRunStore();
    await store.analyze(featureId, client);
    const state = store.getState(featureId);
    expect(state.running).toBe(false);
    expect(state.progress.security.status).toBe('error');
    expect(state.progress.security.error).toContain('without a result');
  });

  it('does not analyze a stale board when reloading fails', async () => {
    const featureId = 'load-failed';
    const client = api(vi.fn().mockResolvedValueOnce(board(featureId, 'sha')).mockRejectedValue(new Error('offline')));
    const store = createReviewBoardRunStore();
    await store.load(featureId, client);
    await store.analyze(featureId, client);
    expect(client.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
    expect(store.getState(featureId).loadError).toBe('offline');
  });

  it('checks graph readiness without fetching a new branch before bulk analysis', async () => {
    const featureId = 'ready-graph';
    const client = api(vi.fn().mockResolvedValue(board(featureId, 'sha')));
    client.getPrReview.mockResolvedValue({ changeGraph: { status: 'ready' } });
    const store = createReviewBoardRunStore();
    await store.analyze(featureId, client, { waitForGraph: true });
    expect(client.getPrReview).toHaveBeenCalled();
    expect(client.pullLatestPrReview).not.toHaveBeenCalled();
    expect(client.analyzeReviewBoardPerspectives).toHaveBeenCalled();
    client.getPrReview.mockResolvedValue({ changeGraph: { status: 'failed', failure: { message: 'Graph timed out' } } });
    client.analyzeReviewBoardPerspectives.mockClear();
    await store.analyze(featureId, client, { waitForGraph: true });
    expect(client.analyzeReviewBoardPerspectives).not.toHaveBeenCalled();
    expect(store.getState(featureId).prep.error).toBe('Graph timed out');
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
