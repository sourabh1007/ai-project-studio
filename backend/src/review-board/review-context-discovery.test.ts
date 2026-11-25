import { describe, expect, it, vi } from 'vitest';
import { createClock } from '../kernel/clock.js';
import type { PrReview } from '../pr-review/pr-review-contract.js';
import type { MetaRequest, MetaRunResult } from '../meta/meta-runner.js';
import type { ReviewContextSnapshot } from './review-run-contract.js';
import { applyDiscoveredReviewContext, createReviewContextDiscovery } from './review-context-discovery.js';

const review = { featureId: 'feature', headSha: 'head', changeGraph: { generatedAt: 'graph' },
  worktreePath: 'C:\\repo', pull: { url: 'https://example.test/pr/1' }, description: 'Preserve one charge on retry.' } as PrReview;
const context: ReviewContextSnapshot = { fingerprint: 'context', skills: [], warnings: [], businessRequirements: 'One charge.',
  evidence: 'chargeOnce(operationKey)', requirements: [
    { id: 'r1', source: 'REQUIREMENTS.md@base', text: 'One charge.', priority: 10, fingerprint: 'rhash' },
  ] };
const inferred = { text: 'Reuse the operation key.', kind: 'inferred', sourceId: 'captured-code', quote: 'operationKey' };
const documented = { text: 'Charge a purchase only once.', kind: 'documented', sourceId: 'r1', quote: 'One charge.' };
const response = { summary: 'Retries should not duplicate purchases.', requirements: [documented, inferred], questions: ['What is the retry retention period?'] };

function harness(text = JSON.stringify(response), config = { stepTimeoutMs: 300_000 }) {
  const ai = { runDetailed: vi.fn(async (_request: MetaRequest): Promise<MetaRunResult> => ({
    text, sessionId: 'meta', requestedModel: 'selected', resolvedModel: 'actual',
  })) };
  const cleanup = vi.fn(async () => {});
  const temporaryPrompts = { create: vi.fn(async (_prompt: string, _cwd: string) => ({ path: 'C:\\prompt.txt', cleanup })) };
  const settings = { coldInlineMaxChars: 20_000, ...config };
  const loader = createReviewContextDiscovery({ ai, config: settings, clock: createClock(), temporaryPrompts });
  return { ai, loader, cleanup, temporaryPrompts, settings, load: (signal?: AbortSignal) => loader.discover(review, context,
    { providerId: 'provider', model: 'selected', runId: 'run' }, signal) };
}

describe('metasession review context', () => {
  it('gathers cited expectations without tools, distinguishes policy from inference, and preserves attribution', async () => {
    const { ai, load } = harness('```json\n' + JSON.stringify({ ...response,
      requirements: [...response.requirements, inferred] }) + '\n```');
    const discovery = await load();
    expect(discovery).toMatchObject({ status: 'loaded', headSha: 'head', graphGeneratedAt: 'graph',
      contextFingerprint: 'context', sessionId: 'meta', requestedModel: 'selected', resolvedModel: 'actual' });
    expect(discovery.requirements).toHaveLength(2);
    expect(discovery.requirements[0]).toMatchObject({ source: 'REQUIREMENTS.md@base', kind: 'documented', quote: 'One charge.' });
    expect(ai.runDetailed).toHaveBeenCalledWith(expect.objectContaining({
      noTools: true, cwd: 'C:\\repo', scope: 'internal', label: 'Review board · business context',
      correlation: { agentId: 'review-board', runId: 'run', contextFingerprint: 'context' },
    }));
    expect(ai.runDetailed.mock.calls[0][0].prompt).toContain('1-2 short sentences');
    expect(ai.runDetailed.mock.calls[0][0].prompt).toContain('unsupported diagram fields');
    const original = structuredClone(context);
    const frozen = applyDiscoveredReviewContext(context, discovery);
    expect(frozen.businessRequirements).toBe('One charge.');
    expect(frozen.requirements![1]).toMatchObject({ text: inferred.text, priority: 110, source: 'inferred:captured-change:context' });
    expect(frozen.warnings).toContain('Best-effort inferred criteria are not documented business policy.');
    expect(frozen.fingerprint).not.toBe(context.fingerprint);
    expect(context).toEqual(original);
  });

  it('returns an honest empty result when no evidence exists, without spending a metasession', async () => {
    const { ai, loader } = harness();
    const empty = { ...context, requirements: undefined, evidence: '', businessRequirements: '' };
    const result = await loader.discover({ ...review, description: null }, empty, { providerId: 'p', model: 'auto' });
    expect(result.status).toBe('empty');
    expect(result.questions[0]).toContain('acceptance criteria could not be established');
    expect(ai.runDetailed).not.toHaveBeenCalled();
    const frozen = applyDiscoveredReviewContext(empty, result);
    expect(frozen.requirements).toEqual([]);
    expect(frozen.warnings).toEqual([]);
    const failed = applyDiscoveredReviewContext(empty, { ...result, status: 'failed', error: 'Offline' });
    expect(failed.warnings).toContain('Offline');
  });

  it('accepts a source-backed empty answer without claiming requirements or an actual model', async () => {
    const { ai, loader } = harness();
    ai.runDetailed.mockResolvedValue({ text: '{"summary":"","requirements":[],"questions":["Confirm the intended behavior."]}', sessionId: 'meta' });
    const result = await loader.discover(review, { ...context, requirements: [
      { ...context.requirements![0], priority: 100 },
    ] }, { providerId: 'p', model: 'auto' });
    expect(result).toMatchObject({ status: 'empty', requestedModel: 'auto', resolvedModel: null });
  });

  it.each([
    ['not json', 'invalid JSON'],
    ['{"requirements":[]}', 'invalid requirements'],
    [JSON.stringify({ ...response, requirements: [{ ...inferred, sourceId: 'unfetched-issue' }] }), 'missing evidence'],
    [JSON.stringify({ ...response, requirements: [{ ...inferred, quote: 'invented code' }] }), 'missing evidence'],
    [JSON.stringify({ ...response, requirements: [{ ...inferred, kind: 'documented' }] }), 'promotes inferred'],
    ['x'.repeat(20_001), 'invalid JSON'],
  ])('rejects unusable or unsupported context: %s', async (text, error) => {
    await expect(harness(text).load()).rejects.toThrow(error);
  });

  it('passes complete large sources as task text without compacting the snapshot or attaching documents', async () => {
    const { ai, loader, temporaryPrompts } = harness(JSON.stringify({ summary: '', requirements: [], questions: [] }),
      { stepTimeoutMs: 100 });
    const huge = { ...context, requirements: Array.from({ length: 64 }, (_, i) => ({
      id: `r${i}`, source: 's'.repeat(500), text: '"\\'.repeat(4000), priority: 10, fingerprint: 'f',
    })), evidence: 'code'.repeat(10000) };
    await loader.discover({ ...review, description: '' }, huge, { providerId: 'p', model: 'auto' });
    const prompt = ai.runDetailed.mock.calls[0][0].prompt;
    expect(prompt).toContain(JSON.stringify(huge.evidence));
    expect(prompt).toContain(JSON.stringify(huge.requirements[63].text));
    expect(ai.runDetailed.mock.calls[0][0].attachments).toBeUndefined();
    expect(temporaryPrompts.create).not.toHaveBeenCalled();
    const result = await harness().load();
    result.requirements = Array.from({ length: 32 }, () => ({ ...result.requirements[1], text: 'expectation '.repeat(80) }));
    const frozen = applyDiscoveredReviewContext({ ...context, evidence: 'x'.repeat(20000) }, result);
    expect(frozen.evidence).toBe('x'.repeat(20000));
    expect(frozen.requirements).toHaveLength(33);
    expect(frozen.warnings.join(' ')).not.toContain('budget exhausted');
  });

  it('propagates cancellation before launch and after a metasession returns', async () => {
    const { ai, load } = harness();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(load(controller.signal)).rejects.toThrow('cancelled');
    expect(ai.runDetailed).not.toHaveBeenCalled();
    const next = new AbortController();
    ai.runDetailed.mockImplementationOnce(async () => {
      next.abort(new Error('cancelled'));
      return { text: JSON.stringify(response), sessionId: 'meta' };
    });
    await expect(load(next.signal)).rejects.toThrow('cancelled');
  });

  it('keeps task instructions directly accessible in no-tools mode even above the former attachment threshold', async () => {
    const { ai, load, settings, cleanup, temporaryPrompts } = harness();
    settings.coldInlineMaxChars = 1;
    await load();
    expect(temporaryPrompts.create).not.toHaveBeenCalled();
    expect(ai.runDetailed).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: expect.stringContaining('Sources:'), noTools: true }));
    expect(ai.runDetailed.mock.calls[0][0].attachments).toBeUndefined();
    ai.runDetailed.mockRejectedValueOnce(new Error('offline'));
    await expect(load()).rejects.toThrow('offline');
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('grounds autonomously discovered criteria in captured MCP sources and passes them separately from pinned code', async () => {
    const resource = { id: 'mcp:bluebird:0', source: 'mcp:bluebird:repo/code_search@time',
      content: 'Builder markers must be validated before dispatch.', documented: false };
    const base = harness(JSON.stringify({ summary: 'Validate builder identity.', requirements: [{
      text: 'Reject untrusted builder markers.', kind: 'inferred', sourceId: resource.id, quote: 'validated before dispatch',
    }], questions: ['The index revision differs from the captured PR.'] }));
    const resources = { collect: vi.fn(async () => ({ sources: [resource], warnings: ['Index is contextual, not pinned PR proof.'] })) };
    const loader = createReviewContextDiscovery({ ai: base.ai, clock: createClock(), config: base.settings,
      temporaryPrompts: base.temporaryPrompts, resources });
    const discovery = await loader.discover(review, context, { providerId: 'p', model: 'auto' });
    expect(resources.collect).toHaveBeenCalledWith(review, { providerId: 'p', model: 'auto' }, undefined);
    expect(base.ai.runDetailed.mock.calls[0][0]).toMatchObject({ noTools: true });
    expect(base.ai.runDetailed.mock.calls[0][0].prompt).toContain('Never ask the user for clarification');
    expect(base.ai.runDetailed.mock.calls[0][0].prompt).toContain(resource.content);
    const frozen = applyDiscoveredReviewContext(context, discovery);
    expect(frozen.evidence).toBe(context.evidence);
    expect(frozen.resources).toEqual([resource]);
    expect(frozen.requirements![1]).toMatchObject({ priority: 110, text: 'Reject untrusted builder markers.' });
    expect(frozen.warnings).toContain('Index is contextual, not pinned PR proof.');
  });

  it('continues from captured sources after research failure but propagates user cancellation', async () => {
    const base = harness();
    const resources = { collect: vi.fn(async () => { throw new Error('unavailable'); }) };
    const loader = createReviewContextDiscovery({ ai: base.ai, clock: createClock(), config: base.settings,
      temporaryPrompts: base.temporaryPrompts, resources });
    const discovery = await loader.discover(review, context, { providerId: 'p', model: 'auto' });
    expect(discovery.status).toBe('loaded');
    expect(discovery.resourceWarnings).toEqual(['Additional repository context was unavailable; continuing with captured evidence.']);
    const controller = new AbortController();
    resources.collect.mockImplementationOnce(async () => { controller.abort(new Error('cancelled')); throw new Error('stopped'); });
    await expect(loader.discover(review, context, { providerId: 'p', model: 'auto' }, controller.signal)).rejects.toThrow('cancelled');
    expect(base.ai.runDetailed).toHaveBeenCalledTimes(1);
  });

  it('does not promote MCP code/search excerpts into business policy, but accepts explicit documented source evidence', async () => {
    const base = harness(JSON.stringify({ ...response, requirements: [{ ...inferred, sourceId: 'external', kind: 'documented', quote: 'One charge.' }] }));
    const resource = { id: 'external', source: 'verified-policy@revision', content: 'One charge.', documented: false };
    const resources = { collect: vi.fn(async () => ({ sources: [resource], warnings: [] })) };
    const loader = createReviewContextDiscovery({ ai: base.ai, clock: createClock(), config: base.settings,
      temporaryPrompts: base.temporaryPrompts, resources });
    await expect(loader.discover(review, context, selection())).rejects.toThrow('promotes inferred');
    resource.documented = true;
    const discovery = await loader.discover(review, context, selection());
    expect(applyDiscoveredReviewContext(context, discovery).requirements![1]).toMatchObject({
      source: 'documented:verified-policy@revision', priority: 20,
    });
    const withoutRequirements = { ...context, requirements: undefined };
    const frozen = applyDiscoveredReviewContext(withoutRequirements, discovery);
    expect(frozen.requirements).toHaveLength(1);
    expect(applyDiscoveredReviewContext(frozen, discovery).requirements).toHaveLength(1);
    const inferredContext = { ...context, requirements: [{ ...context.requirements![0], priority: 110 }] };
    expect(applyDiscoveredReviewContext(inferredContext, discovery).requirements).toHaveLength(2);
    delete discovery.resources;
    delete discovery.resourceWarnings;
    expect(applyDiscoveredReviewContext(context, discovery).resources).toEqual([]);
  });
});

function selection() { return { providerId: 'p', model: 'auto' }; }
