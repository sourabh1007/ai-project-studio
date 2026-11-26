import { describe, expect, it, vi } from 'vitest';
import { createClock } from '../kernel/clock.js';
import type { MetaRequest, MetaRunResult } from '../meta/meta-runner.js';
import { MetaAbortError } from '../meta/meta-runner.js';
import { metaFanOutCapacity } from '../meta/warm-route-policy.js';
import type { PrReview } from '../pr-review/pr-review-contract.js';
import type { TemporaryPromptFileFactory } from '../repository-context/temporary-prompt-file-port.js';
import { reviewBoardDefaults } from './config.js';
import {
  createReviewBoardService,
  requireReviewEvidence,
  type ReviewBoardServiceDeps,
} from './review-board-service.js';

function step(status: PrReview['problemStatement']['status']) {
  return {
    status,
    metaSessionId: null,
    usage: null,
    failure: null,
    activity: [],
    generatedAt: null,
  };
}

const cleanReview = '{"skipped":false,"summary":"Inspected svc/cache.cs BuildKey; no issues found.","findings":[]}';
const evidencedReview = '{"findings":[{"title":"Cache key bounds","detail":"No bound on user input.","evidence":[{"source":"svc/cache.cs","reason":"BuildKey accepts arbitrary keys"}]}]}';

describe('immutable review runs', () => {
  const contextDiscovery = (contextFingerprint = 'context') => ({
    status: 'loaded' as const, headSha: review.headSha, graphGeneratedAt: 'graph', contextFingerprint,
    generatedAt: '2026-11-02', summary: 'Preserve cache-key boundaries.',
    requirements: [{ text: 'Bound cache keys.', kind: 'inferred' as const, source: 'svc/cache.cs', quote: 'BuildKey' }],
    questions: ['What is the maximum key length?'], sessionId: 'context-meta',
  });

  it('loads durable context for legacy reviews without rewriting results or fabricating a run', async () => {
    const { service, deps, current } = harness();
    const before = structuredClone(current());
    deps.contextDiscovery = { discover: vi.fn(async () => contextDiscovery()) };
    const result = await service.loadContext!('f9', new AbortController().signal);
    expect(result.contextDiscovery!.summary).toContain('cache-key');
    expect(current()).toEqual({ ...before, reviewContextDiscovery: result.contextDiscovery });
    expect(current().reviewBoardRun).toBeUndefined();
    expect(deps.ai.runDetailed).not.toHaveBeenCalled();
    current().changeGraph.generatedAt = 'new-graph';
    expect(service.get('f9').contextDiscovery).toBeUndefined();
    deps.contextDiscovery = undefined;
    await expect(service.loadContext!('f9')).rejects.toThrow('unavailable');
    deps.contextDiscovery = { discover: vi.fn() };
    deps.context = undefined;
    await expect(service.loadContext!('f9')).rejects.toThrow('unavailable');
  });

  it('deduplicates automatic context loading before parallel perspectives and never promotes inference to policy', async () => {
    const { service, deps, current } = harness();
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    deps.contextDiscovery = { discover: vi.fn(async (_review, context) => { await wait; return contextDiscovery(context.fingerprint); }) };
    await service.configure!('f9', {});
    expect(deps.contextDiscovery.discover).not.toHaveBeenCalled();
    const first = service.analyzePerspective('f9', 'security');
    const second = service.analyzePerspective('f9', 'business');
    finish();
    await Promise.all([first, second]);
    expect(deps.contextDiscovery.discover).toHaveBeenCalledTimes(1);
    expect(current().reviewBoardRun!.context.discovery!.sessionId).toBe('context-meta');
    expect(current().reviewBoardRun!.context.requirements![0].priority).toBe(110);
    expect(current().reviewBoardRun!.context.businessRequirements).toBe('');
    expect(current().reviewBoardAnalysis!.analyses.business.assessment).toBe('insufficient-evidence');
    await expect(service.loadContext!('f9')).rejects.toThrow('finish');
  });

  it.each(['offline', 'wrong-snapshot'])('preserves useful analysis and discloses context discovery failure: %s', async (mode) => {
    const { service, deps, current } = harness();
    deps.contextDiscovery = { discover: async () => {
      if (mode === 'offline') throw new Error('Model unavailable');
      return contextDiscovery('other');
    } };
    await service.configure!('f9', {});
    await service.analyzePerspective('f9', 'security');
    expect(current().reviewBoardRun!.context.discovery!.status).toBe('failed');
    expect(current().reviewBoardRun!.context.warnings).toContainEqual(expect.stringContaining('Business context loading failed'));
    expect(current().reviewBoardAnalysis!.analyses.security).toBeDefined();
  });

  it('deduplicates manual loading, prevents options races, and cancels without replacing prior context', async () => {
    const { service, deps, current } = harness();
    current().reviewContextDiscovery = contextDiscovery();
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    deps.contextDiscovery = { discover: vi.fn(async (_review, _context, _selection, signal) => {
      await wait;
      signal!.throwIfAborted();
      return contextDiscovery();
    }) };
    const request = new AbortController();
    const first = service.loadContext!('f9', request.signal);
    const second = service.loadContext!('f9');
    await Promise.resolve();
    await expect(service.configure!('f9', {})).rejects.toThrow('context loading');
    service.cancel!('f9');
    finish();
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    expect(deps.contextDiscovery.discover).toHaveBeenCalledTimes(1);
    expect(current().reviewContextDiscovery).toEqual(contextDiscovery());
    request.abort();
    await expect(service.loadContext!('f9', request.signal)).rejects.toThrow();
  });

  it.each(['head', 'graph', 'run'])('rejects stale manually loaded context when %s changes', async (changed) => {
    const { service, deps, current } = harness();
    deps.contextDiscovery = { discover: async () => {
      if (changed === 'head') current().headSha = 'changed';
      if (changed === 'graph') current().changeGraph.generatedAt = 'changed';
      if (changed === 'run') current().reviewBoardRun = { id: 'other' } as never;
      return contextDiscovery();
    } };
    await expect(service.loadContext!('f9')).rejects.toThrow('evidence changed');
    expect(current().reviewContextDiscovery).toBeUndefined();
  });

  it('uses the default metasession selection, reuses prepared options on manual reload, and respects request aborts', async () => {
    const { service, deps } = harness();
    deps.settings = undefined;
    deps.contextDiscovery = { discover: vi.fn(async (_review, context) => contextDiscovery(context.fingerprint)) };
    await service.loadContext!('f9');
    expect(deps.contextDiscovery.discover).toHaveBeenLastCalledWith(expect.anything(), expect.anything(),
      { providerId: 'default', model: 'auto' }, expect.any(AbortSignal));
    await service.configure!('f9', { businessContext: 'Keep keys bounded.' });
    await service.loadContext!('f9');
    expect(deps.context!.collect).toHaveBeenLastCalledWith(expect.anything(),
      { businessContext: 'Keep keys bounded.' }, expect.any(AbortSignal));
    const controller = new AbortController();
    deps.contextDiscovery.discover = async () => {
      controller.abort(new Error('stop context'));
      return contextDiscovery();
    };
    await expect(service.loadContext!('f9', controller.signal)).rejects.toThrow('stop context');
  });

  it('does not reload context while review options are being prepared', async () => {
    const { service, deps } = harness();
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const collect = deps.context!.collect;
    deps.context!.collect = async (...args) => { await wait; return collect(...args); };
    const preparing = service.configure!('f9', {});
    await expect(service.loadContext!('f9')).rejects.toThrow('finish');
    finish();
    await preparing;
  });

  it('gathers context once for a full review and allows retrying failed discovery manually afterwards', async () => {
    const { service, deps, current } = harness();
    deps.contextDiscovery = { discover: vi.fn(async (_review, context) => contextDiscovery(context.fingerprint)) };
    await service.analyzeAll('f9', { emit: vi.fn() });
    expect(deps.contextDiscovery.discover).toHaveBeenCalledTimes(1);
    expect(current().reviewBoardRun!.context.discovery!.status).toBe('loaded');
    await service.loadContext!('f9');
    expect(deps.contextDiscovery.discover).toHaveBeenCalledTimes(2);
  });

  it.each(['replacement', 'cancelled'])('never freezes loaded context into a %s run', async (mode) => {
    const { service, deps, current, set } = harness();
    deps.contextDiscovery = { discover: async (_review, context) => contextDiscovery(context.fingerprint) };
    await service.configure!('f9', {});
    deps.reviews.save = (next) => {
      set(next);
      if (next.reviewContextDiscovery) {
        if (mode === 'replacement') current().reviewBoardRun!.id = 'replacement';
        else current().reviewBoardRun!.status = 'cancelled';
      }
    };
    await expect(service.analyzePerspective('f9', 'security')).rejects.toThrow('Review changed while loading context');
    expect(current().reviewBoardRun!.context.discovery).toBeUndefined();
  });

  it.each(['replacement', 'cancelled', 'aborted'])('propagates %s during automatic discovery rather than freezing failure into another run', async (mode) => {
    const { service, deps, current } = harness();
    const controller = new AbortController();
    deps.contextDiscovery = { discover: async () => {
      if (mode === 'replacement') current().reviewBoardRun!.id = 'replacement';
      if (mode === 'cancelled') service.cancel!('f9');
      if (mode === 'aborted') controller.abort(new Error('stop context'));
      throw new Error('Discovery interrupted');
    } };
    await service.configure!('f9', {});
    await expect(service.analyzePerspective('f9', 'security', controller.signal)).rejects.toThrow();
    expect(current().reviewBoardRun!.context.discovery).toBeUndefined();
  });
  it('reads legacy repository skills without configuring a run, saving evidence or starting AI', async () => {
    const { service, deps, current } = harness();
    const before = structuredClone(current());
    const inspectSkills = vi.fn(async () => ({ baseSha: 'baseline', skills: [], warnings: ['Discovery incomplete'] }));
    deps.context!.inspectSkills = inspectSkills;
    deps.repository = () => ({ name: 'Owner/Repo', remoteUrl: 'https://example.test/Owner/Repo' });
    const signal = new AbortController().signal;
    expect(await service.repositorySkills!('f9', signal)).toEqual({
      repoId: before.repoId, repository: { name: 'Owner/Repo', remoteUrl: 'https://example.test/Owner/Repo' },
      targetBranch: before.baseBranch, baseSha: 'baseline', skills: [], warnings: ['Discovery incomplete'],
    });
    expect(inspectSkills).toHaveBeenCalledWith(before, signal);
    expect(current()).toEqual(before);
    expect(deps.ai.runDetailed).not.toHaveBeenCalled();
    deps.repository = undefined;
    expect((await service.repositorySkills!('f9')).repository).toBeNull();
    deps.context = undefined;
    expect((await service.repositorySkills!('f9')).warnings).toContain('Repository skill discovery is unavailable.');
    deps.context = { collect: vi.fn() };
    expect((await service.repositorySkills!('f9')).skills).toEqual([]);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(service.repositorySkills!('f9', controller.signal)).rejects.toThrow('cancelled');
  });
  it('uses the saved import preset and rewrites requirement links to durable finding identities', async () => {
    for (const reference of ['business/ai-0', 'unknown']) {
      const { service, current, deps } = harness();
      current().reviewBoardImport = { autoReview: false, options: { model: 'named' } };
      deps.context = { collect: async () => ({ fingerprint: 'context', skills: [], warnings: [],
        businessRequirements: 'Bound cache keys', evidence: JSON.stringify({ path: 'svc/cache.cs', diff: review.changeGraph.nodes[0].diff }),
        requirements: [{ id: 'r1', text: 'Bound cache keys', source: 'Explicit criteria', priority: 0, fingerprint: 'rhash' }] }) };
      deps.ai = aiReturning(JSON.stringify({ summary: 'Unbounded keys violate the rule',
        findings: [{ title: 'Key bounds', detail: 'No bound', requirementIds: ['r1'],
          evidence: [{ source: 'svc/cache.cs', reason: 'Missing guard' }] }],
        requirements: [{ requirementId: 'r1', assessment: 'violated', explanation: 'Missing guard',
          findingIds: [reference], evidence: [{ source: 'svc/cache.cs', reason: 'Missing guard' }] }] }));
      expect((await service.configure!('f9', {})).run!.model).toBe('named');
      if (reference === 'unknown') {
        await expect(service.analyzePerspective('f9', 'business')).rejects.toThrow('identities');
      } else {
        const analysis = await service.analyzePerspective('f9', 'business');
        expect(analysis.requirements![0].findingIds).toEqual([analysis.perspective.findings.find((finding) => finding.id.startsWith('business/ai-'))!.id]);
      }
    }
  });
  it('records run-scoped reversible decisions and invalidates stale confirmations', async () => {
    const { service, current, deps } = harness();
    await service.configure!('f9', {});
    deps.ai = aiReturning('{"findings":[{"title":"A","detail":"Limit A","evidence":[{"source":"svc/cache.cs","reason":"Unbounded A"}]},{"title":"B","detail":"Limit B","evidence":[{"source":"svc/cache.cs","reason":"Unbounded B"}]}]}');
    await service.analyzePerspective('f9', 'security');
    current().reviewBoardRun!.status = 'completed';
    const initial = service.get('f9');
    const groups = initial.uniqueFindings!;
    const action = { expectedRunId: initial.run!.id, expectedAssessmentRevision: initial.run!.revision,
      action: 'merge' as const, groupIds: groups.map((group) => group.id), reason: 'One shared cause and correction' };
    const merged = service.manageFindings!('f9', action);
    expect(merged.uniqueFindings).toHaveLength(1);
    expect(merged.findingHistory).toHaveLength(1);
    expect(merged.run!.revision).toBe(initial.run!.revision + 1);
    expect(() => service.manageFindings!('f9', action)).toThrow('changed');
    const split = service.manageFindings!('f9', { ...action, expectedAssessmentRevision: merged.run!.revision,
      action: 'split', groupIds: [merged.uniqueFindings![0].id], reason: 'Distinct behavior after inspection' });
    expect(split.uniqueFindings!.length).toBeGreaterThan(1);
    const dismissed = service.manageFindings!('f9', { ...action, expectedAssessmentRevision: split.run!.revision,
      action: 'disposition', disposition: 'dismissed', groupIds: split.uniqueFindings!.map((group) => group.id), reason: 'Not introduced by this change' });
    expect(dismissed.summary.open).toBe(0);
    expect(dismissed.findingHistory![2].reason).toContain('Not introduced');
    expect(dismissed.analyses!.security.perspective.findings.length).toBe(groups.flatMap((group) => group.observations).length);
    deps.config.maxFindingEvents = 3;
    expect(() => service.manageFindings!('f9', { ...action, expectedAssessmentRevision: dismissed.run!.revision })).toThrow('history is full');
    current().reviewBoardRun!.status = 'running';
    expect(() => service.manageFindings!('f9', { ...action, expectedAssessmentRevision: dismissed.run!.revision })).toThrow('still running');
    delete current().reviewBoardRun;
    expect(() => service.manageFindings!('f9', action)).toThrow('changed');
  });
  it('matches live discussion conservatively without changing frozen analysis or dispositions', async () => {
    const threads = [
      { id: 'inline', url: 'https://example.test/discussion/1', path: 'svc/cache.cs', line: 1, status: 'active' as const, comments: [] },
      { id: 'pr', path: null, line: null, status: 'resolved' as const, comments: [{ author: null, body: 'Cache key bounds No bound on user input.' }] },
      { id: 'other', path: 'other.cs', line: 1, status: 'active' as const, comments: [] },
      { path: null, line: null, status: 'active' as const, comments: [] },
    ];
    const { service, deps, current } = harness({ prComments: { list: async () => threads } });
    current().changeGraph.nodes[0].diff = '@@ -1 +1 @@\n-old\n+new';
    await service.configure!('f9', {});
    deps.ai = aiReturning('{"findings":[{"title":"Cache key bounds","detail":"No bound on user input.","evidence":[{"source":"svc/cache.cs","reason":"No bound","location":{"path":"svc/cache.cs","line":1,"side":"RIGHT"}}]}]}');
    await service.analyzePerspective('f9', 'security');
    const matched = await service.discussion!('f9');
    expect(Object.values(matched.matches)[0]).toEqual([
      { id: 'inline', status: 'active', url: 'https://example.test/discussion/1' },
      { id: 'pr', status: 'resolved', url: current().pull.url },
    ]);
    expect(matched.warnings[0]).toContain('identifiers');
    deps.config.maxStoredFindings = 1;
    expect((await service.discussion!('f9')).warnings).toContainEqual(expect.stringContaining('thread limit'));
    expect(service.get('f9').uniqueFindings![0].disposition).toBe('open');
    deps.prComments = undefined;
    expect((await service.discussion!('f9')).warnings[0]).toContain('unavailable');
  });
  it('pins real live base revisions during preparation and refuses races or stale local baselines', async () => {
    const live = { headSha: review.headSha!, baseSha: 'live-base', targetBranch: 'main' };
    const { service, deps } = harness({ currentRevisions: async () => live });
    deps.context = { collect: async (input) => ({ fingerprint: 'f', skills: [], warnings: [], businessRequirements: '',
      evidence: '', baseSha: input.baseBranch! }) };
    expect((await service.configure!('f9', {})).run!.context).toMatchObject({ baseSha: 'live-base', targetBranch: 'main' });
    deps.currentRevisions = async () => ({ ...live, headSha: 'other' });
    await expect(service.configure!('f9', {})).rejects.toThrow('remote head');
    let reads = 0;
    deps.currentRevisions = async () => ({ ...live, baseSha: ++reads === 1 ? 'live-base' : 'moved' });
    await expect(service.configure!('f9', {})).rejects.toThrow('target changed');
    deps.currentRevisions = async () => live;
    deps.context = { collect: async () => ({ fingerprint: 'f', skills: [], warnings: [], businessRequirements: '', evidence: '', baseSha: 'stale' }) };
    await expect(service.configure!('f9', {})).rejects.toThrow('target changed');
    deps.context = { collect: async () => ({ fingerprint: 'f', skills: [], warnings: ['Git object unavailable'], businessRequirements: '', evidence: '' }) };
    await expect(service.configure!('f9', {})).rejects.toThrow('Pinned repository context could not be loaded');
  });
  it('rejects a selected model that becomes unavailable before dispatch', async () => {
    const { service, deps } = harness();
    await service.configure!('f9', { model: 'named' });
    deps.models = async () => [];
    await expect(service.analyzePerspective('f9', 'security')).rejects.toThrow('no longer available');
  });
  function harness(overrides: Partial<ReviewBoardServiceDeps> = {}) {
    let current = structuredClone(review);
    current.changeGraph.generatedAt = 'graph';
    const deps = baseDeps({
      config: { ...reviewBoardDefaults },
      reviews: { get: () => structuredClone(current), save: (next) => { current = next; } },
      context: { collect: vi.fn(async (_review, options) => ({
        fingerprint: 'context', skills: [{ id: 's', name: 'Policy', source: 'AGENTS.md',
          content: 'Bound cache keys', fingerprint: 'skill', perspectiveIds: [] }],
        businessRequirements: options.businessContext ?? '', evidence: JSON.stringify({ path: 'svc/cache.cs', diff: _review.changeGraph.nodes[0].diff }),
        warnings: [],
      })) },
      settings: () => ({ providerId: 'copilot', model: 'auto' }),
      models: async () => [{ id: 'named', enabled: true }, { id: 'disabled', enabled: false }],
      nextId: (() => { let n = 0; return () => `run-${++n}`; })(),
      ...overrides,
    });
    const service = createReviewBoardService(deps);
    return { deps, service, current: () => current, set: (next: PrReview) => { current = next; } };
  }
  it('recovers mistyped requirement hashes with exact corrective identities rather than accepting a near match', async () => {
    const { deps, service, current } = harness();
    await service.configure!('f9', {});
    const id = 'requirement:v1:5fd3cf987dbdc3090a074ffd639b50234aad3fddf7c8fb3ee6912291b91efdd8';
    const mistyped = id.slice(0, -1);
    current().reviewBoardRun!.context.requirements = [
      { id, text: 'Preserve the operation key.', source: 'PR intent', priority: 100, fingerprint: 'source' },
    ];
    const response = (requirementId: string) => JSON.stringify({
      assessment: 'insufficient-evidence', summary: 'The captured code does not show the caller.', findings: [],
      requirements: [{ requirementId, assessment: 'not-assessed', explanation: 'Caller evidence is missing.', findingIds: [], evidence: [] }],
    });
    const runDetailed = vi.fn().mockResolvedValueOnce({ text: response(mistyped), sessionId: 's1' })
      .mockResolvedValue({ text: response(id), sessionId: 's2' });
    deps.ai = { runDetailed };
    const result = await service.analyzePerspective('f9', 'security');
    expect(runDetailed).toHaveBeenCalledTimes(2);
    expect(runDetailed.mock.calls[1][0].prompt).toContain(`Invalid requirementId: ${JSON.stringify(mistyped)}`);
    expect(runDetailed.mock.calls[1][0].prompt).toContain(`Valid requirementIds (copy exactly): ${JSON.stringify([id])}`);
    expect(result.requirements![0].requirementId).toBe(id);
    expect(result.assessment).toBe('insufficient-evidence');
    expect(current().reviewBoardRun!.failures.security).toBeUndefined();
  });
  it('discloses missing discussion but retains complete loaded threads in the snapshot and model prompt', async () => {
    const { deps, service, current } = harness({
      prComments: { list: async () => { throw new Error('offline'); } },
    });
    await service.configure!('f9', {});
    expect(current().reviewBoardRun?.context.warnings).toContainEqual(expect.stringContaining('could not be loaded'));
    deps.prComments = { list: async () => [{
      path: null, line: null, status: 'active', comments: [{ author: null, body: 'x'.repeat(30_000) }],
    }] };
    await service.configure!('f9', {});
    expect(current().reviewBoardRun?.discussion?.[0].comments[0].body).toBe('x'.repeat(30_000));
    expect(current().reviewBoardRun?.context.warnings.join(' ')).not.toContain('exceeded');
    let captured = '';
    deps.inlinePrompts = true;
    deps.ai.runDetailed = vi.fn(async (request) => { captured = request.prompt; return { text: cleanReview, sessionId: 's' }; });
    await service.analyzePerspective('f9', 'security');
    expect(captured).toContain('x'.repeat(30_000));
  });
  it('starts the review deadline at execution rather than while a user edits prepared options', async () => {
    const { deps, service } = harness();
    await service.configure!('f9', {});
    const executionTime = '2026-11-02T18:00:00.000Z';
    deps.clock = { ...deps.clock, isoNow: () => executionTime };
    await service.analyzePerspective('f9', 'security');
    expect(vi.mocked(deps.ai.runDetailed).mock.calls[0][0].deadlineAt)
      .toBe(Date.parse(executionTime) + deps.config.reviewTimeoutMs);
  });
  it('gives an explicit saved-run retry a fresh deadline while retaining completed perspectives and frozen context', async () => {
    const { deps, service, current } = harness();
    deps.clock = { ...deps.clock, isoNow: () => '2026-11-02T18:00:00.000Z' };
    await service.configure!('f9', {});
    const original = deps.ai.runDetailed;
    deps.ai.runDetailed = vi.fn(async (request) => {
      if (request.label === 'Review board · security') throw new Error('Unavailable');
      return original(request);
    });
    await service.analyzeAll('f9', { emit: vi.fn() });
    expect(current().reviewBoardRun!.status).toBe('failed');
    const identity = current().reviewBoardRun!.id;
    const fingerprint = current().reviewBoardRun!.context.fingerprint;
    deps.clock = { ...deps.clock, isoNow: () => '2026-11-02T19:00:00.000Z' };
    deps.ai.runDetailed = vi.fn(original);
    await service.analyzeAll('f9', { emit: vi.fn() });
    const requests = vi.mocked(deps.ai.runDetailed).mock.calls.map(([request]) => request);
    expect(requests.map((request) => request.label)).toEqual(['Review board · security', 'Review board · final-decision']);
    expect(requests.every((request) => request.deadlineAt === Date.parse('2026-11-02T19:00:00.000Z') + deps.config.reviewTimeoutMs)).toBe(true);
    expect(current().reviewBoardRun).toMatchObject({ id: identity, status: 'completed', context: { fingerprint } });
  });
  it('discloses failed perspective coverage to Final Decision and cannot certify it as approved', async () => {
    const { deps, service } = harness();
    await service.configure!('f9', {});
    const original = deps.ai.runDetailed;
    deps.ai.runDetailed = vi.fn(async (request) => {
      if (request.label === 'Review board · security') throw new Error('Unavailable');
      return original(request);
    });
    await service.analyzeAll('f9', { emit: vi.fn() });
    const last = vi.mocked(deps.ai.runDetailed).mock.calls.at(-1)![0];
    expect(last.prompt).toContain('missingPerspectiveIds');
    expect(last.prompt).toContain('security');
    const final = service.get('f9').analyses!['final-decision'];
    expect(final.assessment).toBe('insufficient-evidence');
    expect(final.perspective.status).toBe('needs-review');
  });
  it('retries a lens marked failed even when its older analysis survives, and ignores failures outside the saved selection', async () => {
    const { deps, service, current, set } = harness();
    await service.configure!('f9', {});
    await service.analyzeAll('f9', { emit: vi.fn() });
    set({ ...current(), reviewBoardRun: { ...current().reviewBoardRun!, status: 'failed',
      failures: { security: 'The latest attempt failed', retired: 'An obsolete perspective failed' } } });
    vi.mocked(deps.ai.runDetailed).mockClear();
    await service.analyzeAll('f9', { emit: vi.fn() });
    expect(vi.mocked(deps.ai.runDetailed).mock.calls.map(([request]) => request.label))
      .toEqual(['Review board · security', 'Review board · final-decision']);
    expect(current().reviewBoardRun?.status).toBe('completed');
    expect(current().reviewBoardRun?.failures.security).toBeUndefined();
  });
  it('leaves a partial single-lens review resumable and persists failed single-lens attempts', async () => {
    const { deps, service, current } = harness();
    await service.configure!('f9', {});
    await service.analyzePerspective('f9', 'security');
    expect(current().reviewBoardRun?.status).toBe('prepared');
    const original = deps.ai.runDetailed;
    deps.ai.runDetailed = vi.fn(async () => { throw new Error('Cannot start reviewer engine'); });
    await expect(service.analyzePerspective('f9', 'testing')).rejects.toThrow('Cannot start reviewer engine');
    expect(current().reviewBoardRun).toMatchObject({ status: 'failed',
      failures: { testing: expect.stringContaining('Cannot start reviewer engine') } });
    await service.analyzePerspective('f9', 'security');
    expect(current().reviewBoardRun?.status).toBe('failed');
    deps.ai.runDetailed = original;
    await service.analyzePerspective('f9', 'testing');
    expect(current().reviewBoardRun?.status).toBe('prepared');
    expect(current().reviewBoardRun?.failures.testing).toBeUndefined();
  });
  it('keeps a run active until concurrently requested individual perspectives have finished', async () => {
    const { deps, service, current } = harness();
    await service.configure!('f9', {});
    const original = deps.ai.runDetailed;
    let resume!: () => void;
    let gate = new Promise<void>((resolve) => { resume = resolve; });
    deps.ai.runDetailed = vi.fn(async (request) => {
      if (request.label === 'Review board · testing') await gate;
      return original(request);
    });
    const testing = service.analyzePerspective('f9', 'testing');
    try {
      await service.analyzePerspective('f9', 'security');
      expect(current().reviewBoardRun?.status).toBe('running');
    } finally {
      resume();
      await testing;
    }
    expect(current().reviewBoardRun?.status).toBe('prepared');
    await expect(service.analyzePerspective('f9', 'unknown')).rejects.toThrow('Unknown perspective');
    expect(current().reviewBoardRun?.status).toBe('prepared');
    await service.configure!('f9', {});
    gate = new Promise<void>((resolve) => { resume = resolve; });
    deps.ai.runDetailed = vi.fn(async (request) => {
      if (request.label === 'Review board · testing') await gate;
      if (request.label === 'Review board · security') throw new Error('Engine failed');
      return original(request);
    });
    const remaining = service.analyzePerspective('f9', 'testing');
    try {
      await expect(service.analyzePerspective('f9', 'security')).rejects.toThrow('Engine failed');
      expect(current().reviewBoardRun?.status).toBe('running');
      expect(current().reviewBoardRun?.failures.security).toContain('Engine failed');
    } finally {
      resume();
      await remaining;
    }
    expect(current().reviewBoardRun?.status).toBe('failed');
  });
  it('does not overwrite a cancelled or replaced review with a late individual failure', async () => {
    for (const replace of [false, true]) {
      const { deps, service, current, set } = harness();
      await service.configure!('f9', {});
      deps.ai.runDetailed = vi.fn(async () => {
        if (replace) set({ ...current(), reviewBoardRun: { ...current().reviewBoardRun!, id: 'replacement' } });
        else service.cancel!('f9');
        throw new Error('Late engine failure');
      });
      await expect(service.analyzePerspective('f9', 'security')).rejects.toThrow('Late engine failure');
      expect(current().reviewBoardRun?.failures.security).toBeUndefined();
      expect(current().reviewBoardRun?.status).toBe(replace ? 'running' : 'cancelled');
    }
  });
  it('retains the original single-lens error when the review port has no persistence writer', async () => {
    const { deps, service, current } = harness();
    await service.configure!('f9', {});
    deps.reviews = { get: () => current() };
    deps.ai.runDetailed = vi.fn(async () => { throw new Error('Engine failure without writer'); });
    await expect(service.analyzePerspective('f9', 'security')).rejects.toThrow('Engine failure without writer');
  });
  it('keeps excluded optional perspectives available for selection in a subsequent run', async () => {
    const { service } = harness();
    const initial = service.get('f9');
    const core = initial.model.perspectives.filter((item) => item.source === 'core').map((item) => item.id);
    await service.configure!('f9', { perspectiveIds: core });
    const narrowed = service.get('f9');
    expect(narrowed.perspectives.some((item) => item.id === 'business')).toBe(false);
    expect(narrowed.availablePerspectives).toContainEqual(expect.objectContaining({ id: 'business', source: 'detected' }));
    expect(narrowed.availablePerspectives).toContainEqual(expect.objectContaining({ id: 'architecture', source: 'core' }));
    expect(narrowed.availablePerspectives).toContainEqual(expect.objectContaining({ id: 'accessibility' }));
    await service.configure!('f9', { perspectiveIds: [...core, 'business'] });
    expect(service.get('f9').perspectives.some((item) => item.id === 'business')).toBe(true);
  });
  it('retries unsupported evidence before storing anything and rejects skill references from another lens', async () => {
    const { deps, service, current } = harness();
    await service.configure!('f9', {});
    const response = JSON.parse(evidencedReview) as { findings: { skillIds?: string[] }[] };
    response.findings[0].skillIds = ['s'];
    current().reviewBoardRun!.context.skills[0].perspectiveIds = ['architecture'];
    deps.ai = aiReturning(JSON.stringify(response));
    await expect(service.analyzePerspective('f9', 'security')).rejects.toThrow('not supplied');
    expect(vi.mocked(deps.ai.runDetailed).mock.calls.length).toBe(deps.config.transientRetryAttempts + 1);
    expect(current().reviewBoardAnalysis).toBeUndefined();
  });
  it('prepares immutable options, forwards model/skills/evidence, and runs final synthesis last', async () => {
    const { deps, service, current } = harness();
    const board = await service.configure!('f9', { model: 'named', businessContext: 'Keys must be bounded.' });
    expect(board.run).toMatchObject({ status: 'prepared', model: 'named', providerId: 'copilot' });
    const events: unknown[] = [];
    await service.analyzeAll('f9', { emit: (event) => events.push(event) });
    const calls = vi.mocked(deps.ai.runDetailed).mock.calls.map(([request]) => request);
    expect(calls.at(-1)?.label).toBe('Review board · final-decision');
    expect(calls.every((call) => call.model === 'named' && call.providerId === 'copilot' && call.noTools && !call.toolsOptional)).toBe(true);
    expect(calls[0].prompt).toContain('Bound cache keys');
    expect(calls[0].prompt).toContain('BEGIN CAPTURED REVIEW CONTEXT');
    expect(current().reviewBoardRun?.status).toBe('completed');
    expect(service.get('f9').analyses?.business.assessment).toBe('no-concerns');
    expect(service.get('f9').analyses?.security.resolvedModel).toBeNull();
    expect(events.length).toBe(calls.length * 2);
    await service.configure!('f9', {});
    expect(service.get('f9').analyses).toEqual({});
    expect(current().reviewBoardHistory).toHaveLength(1);
  });
  it.each([true, false])('correlates a prepared legacy review without inventing a perspective (inline=%s)', async (inlinePrompts) => {
    const { deps, service } = harness({ context: undefined, inlinePrompts,
      config: { ...reviewBoardDefaults, coldInlineMaxChars: 1 }, ai: aiReturning('{"findings":[]}') });
    const board = await service.configure!('f9', {});
    await service.analyze('f9');
    expect(vi.mocked(deps.ai.runDetailed).mock.calls[0][0].correlation).toEqual({
      runId: board.run!.id, agentId: 'review-board', contextFingerprint: board.run!.context.fingerprint,
    });
  });
  it('automatically prepares a run and reports missing business evidence without inventing a pass', async () => {
    const { service, current } = harness();
    const board = await service.analyze('f9');
    expect(board.run?.status).toBe('completed');
    expect(current().reviewBoardAnalysis?.analyses.business.assessment).toBe('insufficient-evidence');
    expect(board.problem).toBe('p');
    expect(board.solution).toContain('has not explained the solution yet');
    expect(board.uniqueFindings).toBeDefined();
  });
  it('validates model eligibility and required lenses', async () => {
    const { service } = harness();
    await expect(service.configure!('f9', { model: 'disabled' })).rejects.toThrow('unavailable');
    await expect(service.configure!('f9', { perspectiveIds: ['security'] })).rejects.toThrow('Required');
    await expect(service.configure!('f9', { model: '' })).rejects.toThrow('Invalid');
  });
  it('handles explicit optional perspectives, fallback context, and default identifiers', async () => {
    const { service, current } = harness({ context: undefined, settings: undefined, models: undefined, nextId: undefined });
    const ids = ['problem-solution', 'architecture', 'impact-blast-radius', 'code-quality', 'testing', 'security', 'final-decision', 'accessibility'] as const;
    await service.configure!('f9', { model: 'custom', perspectiveIds: [...ids], businessContext: 'rule' });
    expect(current().reviewBoardRun?.context.warnings).toContain('Repository skill collection is unavailable.');
    expect(service.get('f9').perspectives.some((p) => p.id === 'accessibility')).toBe(true);
    const result = await service.analyzePerspective('f9', 'security');
    expect(result.requestedModel).toBe('custom');
    expect(result.runId).toBeDefined();
  });
  it('rejects changed evidence and overlapping preparation and honors preparation cancellation', async () => {
    const { deps, service, current } = harness();
    let release!: () => void;
    deps.context = { collect: async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { fingerprint: 'f', skills: [], evidence: '', warnings: [], businessRequirements: '' };
    } };
    const first = service.configure!('f9', {});
    await Promise.resolve();
    await expect(service.configure!('f9', {})).rejects.toThrow('already');
    current().headSha = 'different';
    // get() returns copies, so change the source through the harness setter.
    const changed = current(); changed.headSha = 'different';
    release();
    await expect(first).rejects.toThrow('evidence changed');
    const controller = new AbortController(); controller.abort();
    deps.context = { collect: vi.fn(async () => ({ fingerprint: 'f', skills: [], evidence: '', warnings: [], businessRequirements: '' })) };
    await expect(service.configure!('f9', {}, controller.signal)).rejects.toThrow();
  });
  it('persists failures, rejects changed providers and oversized results', async () => {
    const { deps, service, current } = harness();
    await service.configure!('f9', {});
    deps.settings = () => ({ providerId: 'other', model: 'auto' });
    await service.analyzeAll('f9', { emit: vi.fn() });
    expect(current().reviewBoardRun?.status).toBe('failed');
    expect(Object.keys(current().reviewBoardRun!.failures)).toContain('security');
    deps.settings = () => ({ providerId: 'copilot', model: 'auto' });
    await service.configure!('f9', {});
    deps.config = { ...reviewBoardDefaults, maxStoredFindings: 1 };
    deps.ai = aiReturning(JSON.stringify({ findings: [
      { title: 'a', detail: 'a', evidence: [{ source: 'svc/cache.cs', reason: 'a' }] },
      { title: 'b', detail: 'b', evidence: [{ source: 'svc/cache.cs', reason: 'b' }] },
    ] }));
    await expect(service.analyzePerspective('f9', 'security')).rejects.toThrow('storage bound');
  });
  it('cancels durable execution, rejects old run writes, and shares concurrent runs', async () => {
    const { deps, service, current } = harness();
    await service.configure!('f9', {});
    let finish!: (result: MetaRunResult) => void;
    deps.ai.runDetailed = vi.fn(() => new Promise<MetaRunResult>((resolve) => { finish = resolve; }));
    deps.config = { ...reviewBoardDefaults, maxConcurrentReviews: 1 };
    const work = service.analyzeAll('f9', { emit: vi.fn() });
    await Promise.resolve();
    await expect(service.configure!('f9', {})).rejects.toThrow('Cancel');
    const shared = service.analyzeAll('f9', { emit: vi.fn() });
    service.cancel!('f9');
    finish({ text: cleanReview, sessionId: 's' });
    await work; await shared;
    expect(current().reviewBoardRun?.status).toBe('cancelled');
    await expect(service.analyzePerspective('f9', 'security')).rejects.toThrow('new review');
    await expect(service.analyzeAll('f9', { emit: vi.fn() })).rejects.toThrow('new review');
    service.cancel!('f9');
  });
  it('automatically prepares and shares single-perspective context, exposing cancellation independently', async () => {
    const { deps, service } = harness();
    const first = service.analyzePerspective('f9', 'security');
    const second = service.analyzePerspective('f9', 'security');
    expect((await first).runId).toBe((await second).runId);
    await service.configure!('f9', {});
    deps.ai.runDetailed = vi.fn(async () => {
      service.cancel!('f9');
      return { text: cleanReview, sessionId: 's' };
    });
    await expect(service.analyzePerspective('f9', 'security')).rejects.toThrow('cancelled');
  });
  it('shares durable full runs and replays completed results to another subscriber', async () => {
    const { service } = harness();
    await service.configure!('f9', {});
    const emit = vi.fn();
    await Promise.all([service.analyzeAll('f9', { emit: vi.fn() }), service.analyzeAll('f9', { emit })]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'analyzed' }));
    await service.analyzeAll('f9', { emit });
  });
  it('delivers tool-free prompt text with the fixed model and preserves valid supplied assessments', async () => {
    const { service, deps, current } = harness({ inlinePrompts: false,
      config: { ...reviewBoardDefaults, coldInlineMaxChars: 1 } });
    await service.configure!('f9', {});
    deps.ai = aiReturning('{"skipped":true,"reason":"Not applicable","findings":[]}');
    expect((await service.analyzePerspective('f9', 'security')).assessment).toBe('not-applicable');
    expect(vi.mocked(deps.ai.runDetailed).mock.calls[0][0]).toMatchObject({ model: 'auto', toolsOptional: false });
    await service.configure!('f9', {});
    deps.ai = aiReturning(evidencedReview);
    expect((await service.analyzePerspective('f9', 'security')).assessment).toBe('concerns');
    await service.configure!('f9', {});
    deps.ai = aiReturning('{"assessment":"no-concerns","summary":"Checked","findings":[]}');
    expect((await service.analyzePerspective('f9', 'security')).assessment).toBe('no-concerns');
    current().reviewBoardRun!.context.skills = [
      { id: 's', name: 'S', source: 'source', content: 'c', fingerprint: 'f', perspectiveIds: ['security'] },
      { id: 'x', name: 'X', source: 'source', content: 'c', fingerprint: 'f', perspectiveIds: ['architecture'] },
    ];
    await service.analyzePerspective('f9', 'testing');
  });
  it('supports empty fallback business context, missing problem text, and cancellation before configuration', async () => {
    const { service, current } = harness({ context: undefined });
    service.cancel!('f9');
    await service.configure!('f9', {});
    current().problemStatement.content = null;
    expect(service.get('f9').problem).toBe('short');
    current().description = null;
    expect(service.get('f9').problem).toContain('problem has not been explained yet');
  });
});

const review: PrReview = {
  featureId: 'f9',
  repoId: 'r1',
  pull: { number: 42, title: 'Add caching', url: 'https://example.com/pr/42' },
  worktreePath: 'C:/work/pr-42',
  headSha: 'cafe1234babe',
  baseBranch: 'main',
  description: 'short',
  problemStatement: { ...step('ready'), content: 'p', sufficient: true },
  changeGraph: {
    ...step('ready'),
    projects: [{ id: 'p1', name: 'Cache', path: 'svc/cache.csproj' }],
    nodes: [
      {
        path: 'svc/cache.cs',
        projectId: 'p1',
        module: 'Cache',
        category: 'code',
        kind: 'changed',
        changeKind: 'modified',
        diff: '@@',
        whatItDoes: 'x',
        whatChanged: 'y',
        review: [],
      },
    ],
    edges: [],
  },
  changedFiles: 1,
  timestamps: { createdAt: '', updatedAt: '' },
};

/** A temp-prompt factory that records created content and cleanup calls. */
function fakeTemporaryPrompts(): TemporaryPromptFileFactory & {
  created: string[];
  cleaned: number;
} {
  const state = { created: [] as string[], cleaned: 0 };
  const factory: TemporaryPromptFileFactory & {
    created: string[];
    cleaned: number;
  } = {
    created: state.created,
    cleaned: 0,
    async create(content: string) {
      state.created.push(content);
      return {
        path: `C:/tmp/prompt-${state.created.length}.txt`,
        cleanup: async () => {
          factory.cleaned += 1;
        },
      };
    },
  };
  return factory;
}

/** Base deps every test starts from; individual tests override `ai`/flags. */
function baseDeps(
  overrides: Partial<ReviewBoardServiceDeps> = {},
): ReviewBoardServiceDeps {
  return {
    reviews: { get: () => review },
    config: reviewBoardDefaults,
    clock: createClock(() => Date.parse('2026-02-02T00:00:00.000Z')),
    ai: { runDetailed: vi.fn(async () => ({ text: cleanReview, sessionId: 's0' })) },
    bus: { emit: vi.fn() },
    temporaryPrompts: fakeTemporaryPrompts(),
    sleep: vi.fn(async () => {}),
    ...overrides,
  };
}

function aiReturning(text: string): {
  runDetailed: (r: MetaRequest) => Promise<MetaRunResult>;
} {
  return {
    runDetailed: vi.fn(async () => ({ text, sessionId: 's1' })),
  };
}

describe('createReviewBoardService.get', () => {
  it('keeps evidence identity stable when telemetry or step activity updates timestamps', () => {
    const current = structuredClone(review);
    current.changeGraph.generatedAt = 'graph-revision';
    const service = createReviewBoardService(baseDeps({ reviews: { get: () => current } }));
    expect(service.get('f9').reviewUpdatedAt).toBe('graph-revision');
    current.timestamps.updatedAt = 'later-activity-update';
    expect(service.get('f9').reviewUpdatedAt).toBe('graph-revision');
    current.changeGraph.generatedAt = 'replacement-graph';
    expect(service.get('f9').reviewUpdatedAt).toBe('replacement-graph');
  });
  function persisted() {
    let current = structuredClone(review);
    const deps = baseDeps({ reviews: { get: () => current, save: (next) => { current = next; } } });
    return { deps, current: () => current, service: createReviewBoardService(deps) };
  }

  it('persists completed analyses across service/view lifetimes without rerunning AI', async () => {
    const { deps, service, current } = persisted();
    const analysis = await service.analyzePerspective('f9', 'security');
    const reopened = createReviewBoardService(deps);
    const snapshot = reopened.get('f9');
    expect(snapshot.analyses?.security).toEqual(analysis);
    expect(snapshot.perspectives.find((p) => p.id === 'security')).toEqual(analysis.perspective);
    await expect(reopened.analyzePerspective('f9', 'security')).resolves.toEqual(analysis);
    expect(deps.ai.runDetailed).toHaveBeenCalledTimes(1);
    current().changeGraph.status = 'failed';
    current().changeGraph.failure = { message: 'refresh failed', failedAt: 'later' };
    expect(reopened.get('f9').analyses?.security).toEqual(analysis);
    await expect(reopened.analyzePerspective('f9', 'security')).rejects.toThrow('refresh failed');
  });

  it('does not reuse results after the head or graph revision changes', async () => {
    const { service, current } = persisted();
    await service.analyzePerspective('f9', 'security');
    current().headSha = 'new-head';
    expect(service.get('f9').analyses).toEqual({});
    current().headSha = review.headSha;
    current().changeGraph.generatedAt = 'new-graph';
    expect(service.get('f9').analyses).toEqual({});
  });

  it('coalesces concurrent requests for a perspective', async () => {
    const { deps, service } = persisted();
    let finish!: (result: MetaRunResult) => void;
    deps.ai.runDetailed = vi.fn(() => new Promise<MetaRunResult>((r) => { finish = r; }));
    const first = service.analyzePerspective('f9', 'security');
    const second = service.analyzePerspective('f9', 'security');
    // The reviewer awaits the (empty) existing-comment fetch before launching,
    // so flush microtasks to let runDetailed register the resolver.
    await new Promise((r) => setTimeout(r, 0));
    finish({ text: cleanReview, sessionId: 'same' });
    expect(await first).toEqual(await second);
    expect(deps.ai.runDetailed).toHaveBeenCalledTimes(1);
  });
  it('does not mistake inherited object properties for cached analyses', async () => {
    const { service } = persisted();
    await expect(service.analyzePerspective('f9', 'toString')).rejects.toThrow('Unknown perspective');
  });

  it.each(['head', 'graph', 'status'])('rejects a result when its %s changes in flight', async (change) => {
    const { deps, service, current } = persisted();
    deps.ai.runDetailed = vi.fn(async () => {
      if (change === 'head') current().headSha = 'new';
      if (change === 'graph') current().changeGraph.generatedAt = 'new';
      if (change === 'status') current().changeGraph.status = 'failed';
      return { text: cleanReview, sessionId: 's' };
    });
    // Mimic a JSON repository read: each reader gets an immutable snapshot.
    const originalGet = deps.reviews.get;
    deps.reviews.get = () => structuredClone(originalGet('f9'));
    await expect(service.analyzePerspective('f9', 'security')).rejects.toThrow('evidence changed');
    expect(current().reviewBoardAnalysis).toBeUndefined();
  });

  it('does not persist analysis after a caller cancellation', async () => {
    const { deps, service, current } = persisted();
    const controller = new AbortController();
    deps.ai.runDetailed = vi.fn(async () => {
      controller.abort();
      return { text: cleanReview, sessionId: 's' };
    });
    await expect(service.analyzePerspective('f9', 'security', controller.signal)).rejects.toThrow();
    expect(current().reviewBoardAnalysis).toBeUndefined();
  });

  it('does not stream a cached result after the caller disconnects', async () => {
    const { service } = persisted();
    const analysis = await service.analyzePerspective('f9', 'security');
    const controller = new AbortController();
    service.analyzePerspective = async () => {
      controller.abort();
      return analysis;
    };
    const emit = vi.fn();
    await service.analyzeAll('f9', { emit }, controller.signal);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'analyzing' }));
  });
  it('keeps the recorded prerequisite failure instead of replacing it with a stream error', () => {
    expect(() => requireReviewEvidence({
      ...review, changeGraph: {
        ...review.changeGraph, status: 'failed',
        failure: { message: 'Background analysis cancelled during app shutdown.', failedAt: '2026-09-26' },
      },
    })).toThrow('Background analysis cancelled during app shutdown.');
  });
  it('derives a clean board from the feature PR review', () => {
    const service = createReviewBoardService(baseDeps());
    const board = service.get('f9');
    expect(board.featureId).toBe('f9');
    expect(board.repoId).toBe('r1');
    expect(board.pull.number).toBe(42);
    expect(board.model.projectType).toBe('Backend service');
    expect(board.reviewUpdatedAt).toBe('');
    expect(board.generatedAt).toBe('2026-02-02T00:00:00.000Z');
    // Starts clean: no findings and every perspective Not-started until analyzed.
    expect(board.summary).toEqual({
      open: 0,
      blocking: 0,
      warnings: 0,
      suggestions: 0,
    });
    expect(board.perspectives.every((p) => p.findings.length === 0)).toBe(true);
    expect(board.perspectives.every((p) => p.status === 'not-started')).toBe(
      true,
    );
    expect(board.perspectives.every((p) => p.risk === 'unknown')).toBe(true);
    const problem = board.perspectives.find((p) => p.id === 'problem-solution');
    expect(problem?.status).toBe('not-started');
  });

  it('handles a review with no changed files count', () => {
    const service = createReviewBoardService(
      baseDeps({ reviews: { get: () => ({ ...review, changedFiles: null }) } }),
    );
    expect(service.get('f9').changedFiles).toBe(0);
  });

  it('propagates a missing-review error from the port', () => {
    const boom = new Error('no review');
    const get = vi.fn(() => {
      throw boom;
    });
    const service = createReviewBoardService(baseDeps({ reviews: { get } }));
    expect(() => service.get('missing')).toThrow('no review');
  });
});

describe('createReviewBoardService.analyze', () => {
  const findingsJson = `Here you go:\n\`\`\`json
[
  {
    "perspectiveId": "security",
    "title": "Unvalidated cache key",
    "detail": "The cache key is taken from user input without validation.",
    "severity": "high",
    "evidence": [{ "source": "svc/cache.cs", "reason": "key from request", "confidence": 0.8 }]
  }
]
\`\`\``;

  it('merges AI findings without requiring a tool to read the prompt', async () => {
    const temporaryPrompts = fakeTemporaryPrompts();
    const ai = aiReturning(findingsJson);
    const service = createReviewBoardService(
      baseDeps({
        ai,
        temporaryPrompts,
        config: { ...reviewBoardDefaults, coldInlineMaxChars: 0 },
      }),
    );
    const board = await service.analyze('f9');
    const security = board.perspectives.find((p) => p.id === 'security');
    expect(security?.findings).toHaveLength(1);
    expect(security?.status).toBe('blocked');
    expect(board.recommendation).toBe('request-changes');
    const problem = board.perspectives.find((p) => p.id === 'problem-solution');
    expect(problem?.findings.length).toBeGreaterThan(0);
    expect(temporaryPrompts.created).toHaveLength(0);
    expect(temporaryPrompts.cleaned).toBe(0);
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.attachments).toBeUndefined();
    expect(request.prompt).toContain('svc/cache.cs');
    expect(request.noTools).toBe(true);
  });

  it('carries the prompt inline when inlinePrompts is set (no attachment)', async () => {
    const temporaryPrompts = fakeTemporaryPrompts();
    const ai = aiReturning('```json\n[]\n```');
    const service = createReviewBoardService(
      baseDeps({ ai, temporaryPrompts, inlinePrompts: true }),
    );
    const controller = new AbortController();
    await service.analyze('f9', controller.signal);
    expect(temporaryPrompts.created).toHaveLength(0);
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.attachments).toBeUndefined();
    expect(request.prompt).toContain('review findings');
    expect(request.signal).toBe(controller.signal);
  });

  it('carries a small prompt inline on the cold path (under coldInlineMaxChars)', async () => {
    const temporaryPrompts = fakeTemporaryPrompts();
    const ai = aiReturning('```json\n[]\n```');
    const service = createReviewBoardService(
      baseDeps({ ai, temporaryPrompts }),
    );
    await service.analyze('f9');
    expect(temporaryPrompts.created).toHaveLength(0);
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.attachments).toBeUndefined();
    expect(request.prompt).toContain('review findings');
  });

  it('ignores AI findings for unknown perspectives', async () => {
    const ai = aiReturning(
      '```json\n[{"perspectiveId":"nope","title":"x","detail":"y","severity":"low","evidence":[{"source":"a","reason":"b"}]}]\n```',
    );
    const service = createReviewBoardService(baseDeps({ ai }));
    const board = await service.analyze('f9');
    const extra = board.perspectives
      .flatMap((p) => p.findings)
      .filter((f) => f.id.includes('ai-'));
    expect(extra).toHaveLength(0);
  });

  it('retries a transient provider failure then succeeds', async () => {
    const runDetailed = vi
      .fn()
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValueOnce({ text: '```json\n[]\n```', sessionId: 's2' });
    const sleep = vi.fn(async () => {});
    const service = createReviewBoardService(
      baseDeps({ ai: { runDetailed }, sleep }),
    );
    await service.analyze('f9');
    expect(runDetailed).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries a failure the transient classifier does not recognise', async () => {
    // The classifier is a heuristic, so anything it fails to recognise used to
    // die on the first attempt and reach the user as "Internal server error".
    const runDetailed = vi
      .fn()
      .mockRejectedValueOnce(new Error('bad prompt'))
      .mockResolvedValueOnce({ text: '```json\n[]\n```', sessionId: 's2' });
    const sleep = vi.fn(async () => {});
    const service = createReviewBoardService(
      baseDeps({ ai: { runDetailed }, sleep }),
    );
    await service.analyze('f9');
    expect(runDetailed).toHaveBeenCalledTimes(2);
  });

  it('forces the final attempt onto the cold path', async () => {
    // One unhealthy warm session otherwise fails every perspective of a board
    // pass identically, because a dispatched warm turn is never re-routed.
    const runDetailed = vi.fn().mockRejectedValue(new Error('warm session died'));
    const sleep = vi.fn(async () => {});
    const service = createReviewBoardService(
      baseDeps({ ai: { runDetailed }, sleep }),
    );
    await expect(service.analyze('f9')).rejects.toThrow(/warm session died/);
    const attempts = runDetailed.mock.calls.map(([request]) => request.forceCold);
    expect(attempts.slice(0, -1).every((forced) => !forced)).toBe(true);
    expect(attempts[attempts.length - 1]).toBe(true);
  });

  it('skips the warm retries on a timeout but still forces the cold attempt', async () => {
    // A timeout already waited out the whole step budget, so retrying it warm
    // just burns another full budget on the same stuck session. It should jump
    // straight to the single forced-cold attempt without any backoff sleeps.
    const timeout = new MetaAbortError({
      kind: 'timed_out',
      timeoutMs: 120_000,
      termination: 'unconfirmed',
    });
    const runDetailed = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ text: '```json\n[]\n```', sessionId: 's2' });
    const sleep = vi.fn(async () => {});
    const service = createReviewBoardService(
      baseDeps({ ai: { runDetailed }, sleep }),
    );
    await service.analyze('f9');
    expect(runDetailed).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
    const attempts = runDetailed.mock.calls.map(([request]) => request.forceCold);
    expect(attempts[0]).toBeFalsy();
    expect(attempts[1]).toBe(true);
  });

  it('reports the real provider cause instead of a generic failure', async () => {
    const runDetailed = vi.fn().mockRejectedValue('kaboom');
    const service = createReviewBoardService(
      baseDeps({ ai: { runDetailed }, sleep: vi.fn(async () => {}) }),
    );
    // A bare rethrow became an unmapped 500 "Internal server error", leaving the
    // user with no way to tell what actually went wrong.
    await expect(service.analyze('f9')).rejects.toMatchObject({
      kind: 'provider',
      message: expect.stringContaining('kaboom'),
    });
  });

  it('stops retrying immediately when the caller aborts', async () => {
    // Retrying an aborted request wastes provider work on a result nobody
    // will read, so the caller's own error is surfaced untouched.
    const controller = new AbortController();
    const runDetailed = vi.fn(async () => {
      controller.abort();
      throw new Error('caller went away');
    });
    const sleep = vi.fn(async () => {});
    const service = createReviewBoardService(
      baseDeps({ ai: { runDetailed }, sleep }),
    );
    await expect(service.analyze('f9', controller.signal)).rejects.toThrow(
      /caller went away/,
    );
    expect(runDetailed).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('surfaces an abort raised on the final cold attempt untouched', async () => {
    const controller = new AbortController();
    const runDetailed = vi.fn(async (request: MetaRequest) => {
      if (request.forceCold) {
        controller.abort();
        throw new Error('aborted mid-flight');
      }
      throw new Error('warm session died');
    });
    const service = createReviewBoardService(
      baseDeps({ ai: { runDetailed }, sleep: vi.fn(async () => {}) }),
    );
    await expect(service.analyze('f9', controller.signal)).rejects.toThrow(
      /aborted mid-flight/,
    );
  });

  it('falls back to an earlier cause when the last failure has no message', async () => {
    const runDetailed = vi.fn(async (request: MetaRequest) => {
      if (request.forceCold) throw new Error('');
      throw new Error('the original provider complaint');
    });
    const service = createReviewBoardService(
      baseDeps({ ai: { runDetailed }, sleep: vi.fn(async () => {}) }),
    );
    await expect(service.analyze('f9')).rejects.toMatchObject({
      kind: 'provider',
      message: expect.stringContaining('the original provider complaint'),
    });
  });

  it('exhausts retries and surfaces the final transient failure', async () => {
    const runDetailed = vi.fn().mockRejectedValue(new Error('HTTP 503 error'));
    const sleep = vi.fn(async () => {});
    const service = createReviewBoardService(
      baseDeps({
        ai: { runDetailed },
        sleep,
        config: { ...reviewBoardDefaults, transientRetryAttempts: 1 },
      }),
    );
    await expect(service.analyze('f9')).rejects.toThrow('HTTP 503 error');
    expect(runDetailed).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe('createReviewBoardService existing-PR-discussion context', () => {
  const threads = [
    {
      path: 'svc/cache.cs',
      line: 12,
      status: 'active' as const,
      comments: [
        { author: 'alice', body: 'The cache key needs validation.' },
        { author: 'bob', body: 'Agreed, fixed in the next push.' },
      ],
    },
  ];

  it('feeds existing threads and replies into the whole-board prompt', async () => {
    const ai = aiReturning('```json\n[]\n```');
    const list = vi.fn(async () => threads);
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true, prComments: { list } }),
    );
    await service.analyze('f9');
    expect(list).toHaveBeenCalledWith('f9');
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.prompt).toContain('## Existing PR discussion');
    expect(request.prompt).toContain('[active] svc/cache.cs:12');
    expect(request.prompt).toContain('alice: The cache key needs validation.');
  });

  it('feeds existing threads into a single-perspective prompt', async () => {
    const ai = aiReturning(cleanReview);
    const list = vi.fn(async () => threads);
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true, prComments: { list } }),
    );
    await service.analyzePerspective('f9', 'security');
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.prompt).toContain('## Existing PR discussion');
    expect(request.prompt).toContain('bob: Agreed, fixed in the next push.');
  });

  it('runs the review without prior-comment context when the fetch fails', async () => {
    const ai = aiReturning('```json\n[]\n```');
    const list = vi.fn(async () => {
      throw new Error('provider auth failed');
    });
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true, prComments: { list } }),
    );
    await expect(service.analyze('f9')).resolves.toBeDefined();
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.prompt).not.toContain('## Existing PR discussion');
  });

  it('omits the discussion section for a perspective when there are no threads', async () => {
    const ai = aiReturning(cleanReview);
    const list = vi.fn(async () => []);
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true, prComments: { list } }),
    );
    await service.analyzePerspective('f9', 'security');
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.prompt).not.toContain('## Existing PR discussion');
  });
});

describe('createReviewBoardService.analyzePerspective', () => {
  const objectJson = `\`\`\`json
{"skipped": false, "summary": "Inspected svc/cache.cs BuildKey for tainted input.",
 "rationale": [{"label":"Problem","detail":"cache key may be tainted"},{"label":"Verdict","detail":"needs validation"}],
 "checks": [{"item":"svc/cache.cs — BuildKey","finding":"key derived from request","status":"concern"}],
 "findings": [
  {"title":"Unvalidated cache key","detail":"key from user input","severity":"high","evidence":[{"source":"svc/cache.cs","reason":"key from request","confidence":0.8}]}
]}
\`\`\``;

  it('merges AI findings into just the requested perspective', async () => {
    const ai = aiReturning(objectJson);
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'security');
    expect(result.perspectiveId).toBe('security');
    expect(result.skipped).toBe(false);
    expect(result.skipReason).toBeNull();
    expect(result.summary).toBe(
      'Inspected svc/cache.cs BuildKey for tainted input.',
    );
    expect(result.rationale).toEqual([
      { label: 'Problem', detail: 'cache key may be tainted' },
      { label: 'Verdict', detail: 'needs validation' },
    ]);
    expect(result.checks).toEqual([
      {
        item: 'svc/cache.cs — BuildKey',
        finding: 'key derived from request',
        status: 'concern',
      },
    ]);
    expect(result.perspective.id).toBe('security');
    expect(result.perspective.findings).toHaveLength(1);
    expect(result.perspective.status).toBe('blocked');
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.prompt).toContain('Review lens');
  });

  it('reports a skipped perspective with its reason', async () => {
    const ai = aiReturning(
      '```json\n{"skipped": true, "reason": "No configuration changed."}\n```',
    );
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'impact-blast-radius');
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('No configuration changed.');
  });

  it('keeps the deterministic findings when the AI adds nothing', async () => {
    const ai = aiReturning(cleanReview);
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'problem-solution');
    expect(result.perspective.findings.length).toBeGreaterThan(0);
  });

  it('uses the problem/solution prompt and floor for the problem-solution lens', async () => {
    const ai = aiReturning(evidencedReview);
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'problem-solution');
    // Dedicated prompt was used (general problem/solution, not file-by-file).
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.prompt).toContain('Problem ↔ Solution');
    expect(request.prompt).toContain('do NOT grade files one by one');
    expect(request.prompt).toContain('The problem this PR targets');
    expect(request.prompt).toContain('Mandatory problem and solution explanations');
    expect(request.prompt).toContain('"Problem example" and "Solution example"');
    expect(request.prompt).toContain('verbatim contiguous excerpt of at most 12 lines');
    // Floor frames the fallback as Problem / Solution / Why they align / Verdict
    // with NO file-level line-by-line checks.
    expect(result.rationale.map((r) => r.label)).toEqual([
      'Problem',
      'Solution implemented',
      'Why they align',
      'Verdict',
    ]);
    expect(result.rationale[1].detail).toContain('The change spans');
    expect(result.checks).toEqual([]);
    expect(result.summary).toContain('Problem:');
  });

  it('falls back to a placeholder when no problem statement can be distilled', async () => {
    const noProblem: PrReview = {
      ...review,
      problemStatement: { ...review.problemStatement, sufficient: false },
    };
    const ai = aiReturning(cleanReview);
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true, reviews: { get: () => noProblem } }),
    );
    await service.analyzePerspective('f9', 'problem-solution');
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.prompt).toContain(
      'no self-contained problem statement could be distilled',
    );
  });

  it('reads the solution from the description when nothing changed resolves', async () => {
    const boundaryOnly: PrReview = {
      ...review,
      changeGraph: {
        ...review.changeGraph,
        nodes: review.changeGraph.nodes.map((n) => ({
          ...n,
          kind: 'boundary' as const,
        })),
      },
    };
    const ai = aiReturning(cleanReview);
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true, reviews: { get: () => boundaryOnly } }),
    );
    const result = await service.analyzePerspective('f9', 'problem-solution');
    expect(result.rationale[1].detail).toContain(
      'No changed files were resolved',
    );
  });

  it('marks a reviewed-but-clean perspective Approved / Low', async () => {
    const ai = aiReturning(cleanReview);
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'security');
    expect(result.perspective.findings).toHaveLength(0);
    expect(result.perspective.status).toBe('approved');
    expect(result.perspective.risk).toBe('low');
  });

  it('supplements validated evidenced findings from the deterministic floor', async () => {
    const ai = aiReturning(evidencedReview);
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'security');
    expect(result.summary).not.toBeNull();
    expect(result.summary).toContain('Security');
    expect(result.rationale.length).toBeGreaterThan(0);
    expect(result.rationale[0].label).toBe('Concern');
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('retries malformed output and accepts a subsequent valid review', async () => {
    const runDetailed = vi.fn()
      .mockResolvedValueOnce({ text: '{}', sessionId: 'invalid' })
      .mockResolvedValue({ text: cleanReview, sessionId: 'valid' });
    const sleep = vi.fn(async () => {});
    const service = createReviewBoardService(baseDeps({ ai: { runDetailed }, sleep }));
    const result = await service.analyzePerspective('f9', 'security');
    expect(result.summary).toContain('Inspected svc/cache.cs');
    expect(runDetailed).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('recovers from invalid output using the final cold attempt', async () => {
    const runDetailed = vi.fn(async (request: MetaRequest) => ({
      text: request.forceCold ? cleanReview : 'I cannot review this.',
      sessionId: 's1',
    }));
    const service = createReviewBoardService(baseDeps({
      ai: { runDetailed },
      config: { ...reviewBoardDefaults, transientRetryAttempts: 1 },
    }));
    expect((await service.analyzePerspective('f9', 'security')).perspective.status)
      .toBe('approved');
    expect(runDetailed).toHaveBeenLastCalledWith(expect.objectContaining({ forceCold: true }));
  });

  it('retries invalid responses with corrective feedback and full prompt text, forcing the last cold', async () => {
    const temporaryPrompts = fakeTemporaryPrompts();
    const runDetailed = vi.fn(async (request: MetaRequest) => ({
      text: request.forceCold ? cleanReview : '{}',
      sessionId: 's1',
    }));
    const service = createReviewBoardService(baseDeps({
      ai: { runDetailed },
      temporaryPrompts,
      config: {
        ...reviewBoardDefaults, coldInlineMaxChars: 0, transientRetryAttempts: 1,
      },
    }));
    expect((await service.analyzePerspective('f9', 'security')).perspective.status)
      .toBe('approved');
    expect(temporaryPrompts.created).toHaveLength(0);
    expect(temporaryPrompts.cleaned).toBe(0);
    expect(runDetailed).toHaveBeenLastCalledWith(expect.objectContaining({
      forceCold: true, noTools: true, prompt: expect.stringContaining('previous'),
    }));
    expect(runDetailed.mock.calls.every(([request]) => !request.attachments)).toBe(true);
  });

  it.each(['', '{}', 'I cannot review this.', '[]', '{"findings":[]}'])(
    'never returns completed analysis for invalid output %s', async (text) => {
      const ai = aiReturning(text);
      const service = createReviewBoardService(baseDeps({
        ai, config: { ...reviewBoardDefaults, transientRetryAttempts: 1 },
      }));
      await expect(service.analyzePerspective('f9', 'security')).rejects.toMatchObject({
        kind: 'provider',
        message: expect.stringContaining('Retry this perspective'),
      });
      expect(ai.runDetailed).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps the model detail when it is provided (floor not used)', async () => {
    const result = await createReviewBoardService(
      baseDeps({ ai: aiReturning(objectJson), inlinePrompts: true }),
    ).analyzePerspective('f9', 'security');
    expect(result.summary).toBe(
      'Inspected svc/cache.cs BuildKey for tainted input.',
    );
    expect(result.rationale).toEqual([
      { label: 'Problem', detail: 'cache key may be tainted' },
      { label: 'Verdict', detail: 'needs validation' },
    ]);
  });

  it('returns the model detail as-is for a skipped lens (no floor)', async () => {
    const ai = aiReturning(
      '```json\n{"skipped": true, "reason": "No config changed."}\n```',
    );
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'impact-blast-radius');
    expect(result.skipped).toBe(true);
    expect(result.summary).toBeNull();
    expect(result.rationale).toEqual([]);
    expect(result.checks).toEqual([]);
  });

  it('marks a skipped, finding-less perspective Not-applicable', async () => {
    const ai = aiReturning(
      '```json\n{"skipped": true, "reason": "No security-relevant code changed."}\n```',
    );
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'security');
    expect(result.skipped).toBe(true);
    expect(result.perspective.status).toBe('not-applicable');
    expect(result.perspective.risk).toBe('unknown');
  });

  it('rejects an unknown perspective id', async () => {
    const service = createReviewBoardService(baseDeps({ inlinePrompts: true }));
    await expect(
      service.analyzePerspective('f9', 'ghost'),
    ).rejects.toThrow('Unknown perspective: ghost');
  });

  it('streams live activity for the perspective over the bus (inline path)', async () => {
    const emit = vi.fn();
    const runDetailed = vi.fn(async (r: MetaRequest) => {
      r.onStart?.('meta-123');
      r.onActivity?.('Reading svc/cache.cs…');
      r.onActivity?.('Assessing BuildKey…');
      return { text: objectJson, sessionId: 'meta-123' };
    });
    const service = createReviewBoardService(
      baseDeps({ ai: { runDetailed }, bus: { emit }, inlinePrompts: true }),
    );
    await service.analyzePerspective('f9', 'security');
    // The onStart banner line plus each activity line, all tagged with the
    // metasession id and the perspective they belong to.
    expect(emit).toHaveBeenCalledWith('review.board.activity', {
      featureId: 'f9',
      perspectiveId: 'security',
      sessionId: 'meta-123',
      line: 'Reviewer session started — reading the change evidence…',
    });
    expect(emit).toHaveBeenCalledWith('review.board.activity', {
      featureId: 'f9',
      perspectiveId: 'security',
      sessionId: 'meta-123',
      line: 'Reading svc/cache.cs…',
    });
    expect(emit).toHaveBeenCalledWith('review.board.activity', {
      featureId: 'f9',
      perspectiveId: 'security',
      sessionId: 'meta-123',
      line: 'Assessing BuildKey…',
    });
  });

  it('streams live activity over the bus on the attachment (cold) path', async () => {
    const emit = vi.fn();
    const runDetailed = vi.fn(async (r: MetaRequest) => {
      r.onStart?.('meta-cold');
      r.onActivity?.('Inspecting the diff…');
      return { text: objectJson, sessionId: 'meta-cold' };
    });
    const service = createReviewBoardService(
      baseDeps({
        ai: { runDetailed },
        bus: { emit },
        config: { ...reviewBoardDefaults, coldInlineMaxChars: 0 },
      }),
    );
    await service.analyzePerspective('f9', 'security');
    expect(emit).toHaveBeenCalledWith('review.board.activity', {
      featureId: 'f9',
      perspectiveId: 'security',
      sessionId: 'meta-cold',
      line: 'Inspecting the diff…',
    });
  });
});

describe('createReviewBoardService.chat', () => {
  it('answers with the trimmed completion, scoped to a perspective', async () => {
    const ai = aiReturning('  The blast radius is wide.  ');
    const service = createReviewBoardService(
      baseDeps({ ai, config: { ...reviewBoardDefaults, coldInlineMaxChars: 0 } }),
    );
    const reply = await service.chat('f9', 'impact-blast-radius', [
      { role: 'user', content: 'Why is this risky?' },
    ]);
    expect(reply.answer).toBe('The blast radius is wide.');
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.prompt).toContain('Why is this risky?');
    expect(request.attachments).toBeUndefined();
  });

  it('answers a board-wide question when perspectiveId is null', async () => {
    const ai = aiReturning('Overall it needs review.');
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true }),
    );
    const reply = await service.chat('f9', null, [
      { role: 'user', content: 'Summarize.' },
    ]);
    expect(reply.answer).toBe('Overall it needs review.');
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.prompt).toContain('Engineering Review Agent');
  });

  it('tolerates a perspectiveId that is not on the board', async () => {
    const ai = aiReturning('n/a');
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true }),
    );
    const reply = await service.chat('f9', 'ghost', [
      { role: 'user', content: 'Hi' },
    ]);
    expect(reply.answer).toBe('n/a');
    expect(reply.ratingChange).toBeNull();
  });

  it('surfaces a convinced rating change for the focused perspective', async () => {
    const ai = aiReturning(
      'You are right — svc/cache.cs BuildKey bounds growth.\n' +
        '```json\n' +
        '{"status":"approved","risk":"low","summary":"Re-checked BuildKey.",' +
        '"rationale":[{"label":"Evidence","detail":"cap at svc/cache.cs:42"}],' +
        '"justification":"You showed the cap at line 42."}\n' +
        '```',
    );
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true }),
    );
    const reply = await service.chat('f9', 'security', [
      { role: 'user', content: 'The cap at line 42 bounds it.' },
    ]);
    expect(reply.answer).toBe(
      'You are right — svc/cache.cs BuildKey bounds growth.',
    );
    expect(reply.ratingChange).toEqual({
      perspectiveId: 'security',
      status: 'approved',
      risk: 'low',
      summary: 'Re-checked BuildKey.',
      rationale: [{ label: 'Evidence', detail: 'cap at svc/cache.cs:42' }],
      justification: 'You showed the cap at line 42.',
    });
  });

  it('prefers the analysed findings the client sends over the derived board', async () => {
    const ai = aiReturning('Line 42 in svc/cache.cs BuildKey.');
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true }),
    );
    const reply = await service.chat(
      'f9',
      'security',
      [{ role: 'user', content: 'where is this code?' }],
      {
        status: 'warning',
        risk: 'high',
        findings: [
          {
            id: 'af1',
            perspectiveId: 'security',
            title: 'Unbounded cache growth',
            detail: 'BuildKey never caps the map.',
            severity: 'high',
            status: 'warning',
            evidence: [
              {
                source: 'svc/cache.cs',
                reason: 'BuildKey',
                confidence: 1,
                direct: true,
              },
            ],
          },
        ],
      },
    );
    expect(reply.answer).toBe('Line 42 in svc/cache.cs BuildKey.');
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    // The client's analysed finding + its evidence source reaches the prompt.
    expect(request.prompt).toContain('Unbounded cache growth');
    expect(request.prompt).toContain('Evidence: svc/cache.cs');
    expect(request.prompt).toContain('Risk: high');
  });

  it('ignores client context when the perspective is not on the board', async () => {
    const ai = aiReturning('n/a');
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true }),
    );
    const reply = await service.chat(
      'f9',
      'ghost',
      [{ role: 'user', content: 'Hi' }],
      { status: 'warning', risk: 'high', findings: [] },
    );
    expect(reply.answer).toBe('n/a');
  });
});

describe('createReviewBoardService.analyzeAll', () => {
  type Event = Parameters<
    Parameters<
      ReturnType<typeof createReviewBoardService>['analyzeAll']
    >[1]['emit']
  >[0];

  function collect(): { sink: { emit: (e: Event) => void }; events: Event[] } {
    const events: Event[] = [];
    return { events, sink: { emit: (e) => events.push(e) } };
  }

  it('streams analyzing then analyzed for every board perspective', async () => {
    const service = createReviewBoardService(baseDeps({ inlinePrompts: true }));
    const ids = service.get('f9').perspectives.map((p) => p.id);
    const { sink, events } = collect();
    await service.analyzeAll('f9', sink);
    const analyzing = events
      .filter((e) => e.type === 'analyzing')
      .map((e) => (e.type === 'analyzing' ? e.perspectiveId : ''));
    const analyzed = events
      .filter((e) => e.type === 'analyzed')
      .map((e) => (e.type === 'analyzed' ? e.analysis.perspectiveId : ''));
    expect(ids.length).toBeGreaterThan(1);
    expect([...analyzing].sort()).toEqual([...ids].sort());
    expect([...analyzed].sort()).toEqual([...ids].sort());
    expect(events.some((e) => e.type === 'failed')).toBe(false);
  });

  it('throws when the review does not exist, before streaming anything', async () => {
    const service = createReviewBoardService(
      baseDeps({
        reviews: {
          get: () => {
            throw new Error('no review');
          },
        },
      }),
    );
    const { sink, events } = collect();
    await expect(service.analyzeAll('missing', sink)).rejects.toThrow(
      'no review',
    );
    expect(events).toHaveLength(0);
  });

  it('streams a failed event (not a throw) when a perspective analysis errors', async () => {
    const ai = {
      runDetailed: vi.fn(async () => {
        throw new Error('model exploded');
      }),
    };
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const { sink, events } = collect();
    await service.analyzeAll('f9', sink);
    const failed = events.filter((e) => e.type === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(
      failed.every((e) => e.type === 'failed' && e.error.length > 0),
    ).toBe(true);
    expect(events.some((e) => e.type === 'analyzed')).toBe(false);
  });

  it('streams failures, never analyzed events, for invalid model output', async () => {
    const service = createReviewBoardService(baseDeps({
      ai: aiReturning('{}'),
      config: { ...reviewBoardDefaults, transientRetryAttempts: 0 },
    }));
    const { sink, events } = collect();
    await service.analyzeAll('f9', sink);
    expect(events.filter((e) => e.type === 'failed')).toHaveLength(
      service.get('f9').perspectives.length,
    );
    expect(events.some((e) => e.type === 'analyzed')).toBe(false);
    expect(events.filter((e) => e.type === 'failed')).toEqual(
      expect.arrayContaining([expect.objectContaining({
        error: expect.stringContaining('Retry this perspective'),
      })]),
    );
  });

  it.each([
    ['acp', 3, 10, 2],
    [undefined, 0, 10, 9],
  ] as const)('reserves one slot using %s capacity for parallel perspectives', async (transport, live, target, expectedPeak) => {
    let active = 0;
    let peak = 0;
    const ai = {
      runDetailed: vi.fn(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { text: cleanReview, sessionId: 's1' };
      }),
    };
    const liveMetaSessions = vi.fn(() => metaFanOutCapacity(transport, live, target));
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true, liveMetaSessions }),
    );
    const { sink } = collect();
    await service.analyzeAll('f9', sink);
    expect(peak).toBe(expectedPeak);
    // Re-read on every scheduling decision so mid-run pool growth is picked up.
    expect(liveMetaSessions.mock.calls.length).toBeGreaterThan(1);
  });

  it('runs one at a time when no warm sessions are reported', async () => {
    let active = 0;
    let peak = 0;
    const ai = {
      runDetailed: vi.fn(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return { text: cleanReview, sessionId: 's1' };
      }),
    };
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true, liveMetaSessions: () => 0 }),
    );
    const { sink } = collect();
    await service.analyzeAll('f9', sink);
    expect(peak).toBe(1);
  });

  describe('Review Board change graph prerequisite', () => {
    it.each(['pending', 'generating', 'failed'] as const)(
      'rejects every analysis entry point while the graph is %s', async (status) => {
        const ai = aiReturning(cleanReview);
        const emit = vi.fn();
        const service = createReviewBoardService(baseDeps({
          ai,
          reviews: { get: () => ({
            ...review, changeGraph: { ...review.changeGraph, status },
          }) },
        }));
        expect(service.get('f9').perspectives.length).toBeGreaterThan(0);
        for (const analyze of [
          () => service.analyze('f9'),
          () => service.analyzePerspective('f9', 'security'),
          () => service.analyzeAll('f9', { emit }),
        ]) {
          await expect(analyze()).rejects.toMatchObject({
            kind: 'validation',
            message: expect.stringContaining(`ready change graph (currently ${status})`),
          });
        }
        expect(ai.runDetailed).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
      },
    );
  });

  it('emits nothing when the signal is already aborted', async () => {
    const service = createReviewBoardService(baseDeps({ inlinePrompts: true }));
    const controller = new AbortController();
    controller.abort();
    const { sink, events } = collect();
    await service.analyzeAll('f9', sink, controller.signal);
    expect(events).toHaveLength(0);
  });

  it('stops emitting results once aborted mid-pass (success in flight)', async () => {
    const service = createReviewBoardService(
      baseDeps({ inlinePrompts: true, liveMetaSessions: () => 3 }),
    );
    const controller = new AbortController();
    const events: Event[] = [];
    const sink = {
      emit: (e: Event) => {
        events.push(e);
        if (e.type === 'analyzing') controller.abort();
      },
    };
    await service.analyzeAll('f9', sink, controller.signal);
    // Analyzing lines may appear, but no terminal result should be streamed.
    expect(events.some((e) => e.type === 'analyzed')).toBe(false);
    expect(events.some((e) => e.type === 'failed')).toBe(false);
  });

  it('stops emitting results once aborted mid-pass (failure in flight)', async () => {
    const ai = {
      runDetailed: vi.fn(async () => {
        throw new Error('model exploded');
      }),
    };
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true, liveMetaSessions: () => 2 }),
    );
    const controller = new AbortController();
    const events: Event[] = [];
    const sink = {
      emit: (e: Event) => {
        events.push(e);
        if (e.type === 'analyzing') controller.abort();
      },
    };
    await service.analyzeAll('f9', sink, controller.signal);
    expect(events.some((e) => e.type === 'failed')).toBe(false);
  });
});
