import { describe, expect, it } from 'vitest';
import type { PrReview, RepositoryContext, Session, StoredUsage } from './types.js';
import {
  applyStreamEvent,
  initialLiveState,
  liveSignal,
  parseServerEvent,
  resolveSessionMetrics,
  sessionLiveTotals,
  usageKey,
  workspaceLiveTotals,
} from './stream.js';

function session(id: string): Session {
  return {
    id,
    featureId: 'f1',
    name: null,
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'running',
    kind: 'dev',
    prompt: 'p',
    usageFilePath: 'u.jsonl',
    createdAt: '2025-01-01T00:00:00Z',
    startedAt: '2025-01-01T00:00:00Z',
    endedAt: null,
    exitCode: null,
  };
}

function usage(sessionId: string, turnIndex: number): StoredUsage {
  return {
    sessionId,
    featureId: 'f1',
    turnIndex,
    kind: 'dev',
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5.4',
    operation: 'chat',
    serviceRequestId: null,
    startedAt: '2025-01-01T00:00:00Z',
    endedAt: '2025-01-01T00:00:01Z',
    sessions: 1,
    inputTokens: 10,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    cost: 0.5,
    credits: 1,
    nanoAiu: 100,
  };
}

function repositoryContext(status: RepositoryContext['status']): RepositoryContext {
  return {
    repositoryId: 'r1',
    status,
    content: status === 'ready' ? 'summary' : null,
    sourceRevision: 'abc123',
    timestamps: {
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:01Z',
      generationStartedAt: null,
      generatedAt: status === 'ready' ? '2025-01-01T00:00:01Z' : null,
    },
    steps: [],
    failure: null,
  };
}

function prReview(status: PrReview['status']): PrReview {
  return {
    featureId: 'f1',
    repoId: 'r1',
    pull: { number: 7, title: 'Add retry', url: 'https://example.com/pr/7' },
    worktreePath: 'C:\\wt',
    baseBranch: 'main',
    status,
    summary: status === 'ready' ? 'Adds retry.' : null,
    coreAnalysis: status === 'ready' ? '- wraps client' : null,
    changedFiles: status === 'ready' ? 3 : null,
    timestamps: {
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:01Z',
      generatedAt: status === 'ready' ? '2025-01-01T00:00:01Z' : null,
    },
    failure: null,
  };
}

describe('usageKey', () => {
  it('joins session id and turn index', () => {
    expect(usageKey('s1', 3)).toBe('s1:3');
  });
});

describe('parseServerEvent', () => {
  it('parses session.started', () => {
    const event = parseServerEvent(
      'session.started',
      JSON.stringify(session('s1')),
    );
    expect(event).toEqual({ type: 'session.started', session: session('s1') });
  });

  it('parses session.ended', () => {
    const event = parseServerEvent(
      'session.ended',
      JSON.stringify(session('s1')),
    );
    expect(event?.type).toBe('session.ended');
  });

  it('parses session.updated', () => {
    const updated = { ...session('s1'), resolvedModel: 'claude-opus-4.8' };
    const event = parseServerEvent('session.updated', JSON.stringify(updated));
    expect(event).toEqual({ type: 'session.updated', session: updated });
  });

  it('parses a stdout output frame', () => {
    const event = parseServerEvent(
      'session.output',
      JSON.stringify({ sessionId: 's1', event: { type: 'stdout', line: 'hi' } }),
    );
    expect(event).toEqual({ type: 'session.output', sessionId: 's1', line: 'hi' });
  });

  it('parses a stderr output frame', () => {
    const event = parseServerEvent(
      'session.output',
      JSON.stringify({ sessionId: 's1', event: { type: 'stderr', line: 'oops' } }),
    );
    expect(event).toEqual({
      type: 'session.output',
      sessionId: 's1',
      line: 'oops',
    });
  });

  it('defaults a missing output line to empty string', () => {
    const event = parseServerEvent(
      'session.output',
      JSON.stringify({ sessionId: 's1', event: { type: 'stdout' } }),
    );
    expect(event).toEqual({ type: 'session.output', sessionId: 's1', line: '' });
  });

  it('ignores non-output frames like exit', () => {
    const event = parseServerEvent(
      'session.output',
      JSON.stringify({ sessionId: 's1', event: { type: 'exit' } }),
    );
    expect(event).toBeNull();
  });

  it('parses usage.recorded', () => {
    const event = parseServerEvent(
      'usage.recorded',
      JSON.stringify(usage('s1', 0)),
    );
    expect(event?.type).toBe('usage.recorded');
  });

  it('parses repository context updates', () => {
    const context = repositoryContext('generating');
    expect(
      parseServerEvent('repository.context.updated', JSON.stringify(context)),
    ).toEqual({ type: 'repository.context.updated', context });
  });

  it('parses PR review updates', () => {
    const review = prReview('generating');
    expect(
      parseServerEvent('pr.review.updated', JSON.stringify(review)),
    ).toEqual({ type: 'pr.review.updated', review });
  });

  it('returns null for unknown event names', () => {
    expect(parseServerEvent('mystery', '{}')).toBeNull();
  });
});

describe('applyStreamEvent', () => {
  it('records a started session', () => {
    const state = applyStreamEvent(initialLiveState, {
      type: 'session.started',
      session: session('s1'),
    });
    expect(state.sessions['s1']).toBeDefined();
  });

  it('records an ended session', () => {
    const state = applyStreamEvent(initialLiveState, {
      type: 'session.ended',
      session: session('s1'),
    });
    expect(state.sessions['s1']).toBeDefined();
  });

  it('overwrites a session on session.updated (e.g. resolved model)', () => {
    let state = applyStreamEvent(initialLiveState, {
      type: 'session.started',
      session: session('s1'),
    });
    state = applyStreamEvent(state, {
      type: 'session.updated',
      session: { ...session('s1'), resolvedModel: 'claude-opus-4.8' },
    });
    expect(state.sessions['s1'].resolvedModel).toBe('claude-opus-4.8');
  });

  it('appends output lines per session', () => {
    let state = applyStreamEvent(initialLiveState, {
      type: 'session.output',
      sessionId: 's1',
      line: 'a',
    });
    state = applyStreamEvent(state, {
      type: 'session.output',
      sessionId: 's1',
      line: 'b',
    });
    expect(state.outputBySession['s1']).toEqual(['a', 'b']);
  });

  it('dedupes usage by session and turn', () => {
    let state = applyStreamEvent(initialLiveState, {
      type: 'usage.recorded',
      usage: usage('s1', 0),
    });
    state = applyStreamEvent(state, {
      type: 'usage.recorded',
      usage: { ...usage('s1', 0), credits: 99 },
    });
    expect(Object.keys(state.usageByKey)).toHaveLength(1);
    expect(state.usageByKey['s1:0'].credits).toBe(99);
  });

  it('keeps the latest repository context by repository id', () => {
    let state = applyStreamEvent(initialLiveState, {
      type: 'repository.context.updated',
      context: repositoryContext('generating'),
    });
    state = applyStreamEvent(state, {
      type: 'repository.context.updated',
      context: repositoryContext('ready'),
    });
    expect(state.repositoryContexts['r1'].status).toBe('ready');
  });

  it('keeps the latest PR review by feature id', () => {
    let state = applyStreamEvent(initialLiveState, {
      type: 'pr.review.updated',
      review: prReview('generating'),
    });
    state = applyStreamEvent(state, {
      type: 'pr.review.updated',
      review: prReview('ready'),
    });
    expect(state.prReviews['f1'].status).toBe('ready');
  });

  it('tracks the latest context-status phase per scope target', () => {
    let state = applyStreamEvent(initialLiveState, {
      type: 'context.status',
      status: { scope: 'feature', scopeId: 'f1', phase: 'generating' },
    });
    expect(state.contextStatus['feature:f1']).toBe('generating');
    state = applyStreamEvent(state, {
      type: 'context.status',
      status: { scope: 'feature', scopeId: 'f1', phase: 'idle' },
    });
    expect(state.contextStatus['feature:f1']).toBe('idle');
  });

  it('parses a context.status frame', () => {
    const parsed = parseServerEvent(
      'context.status',
      JSON.stringify({ scope: 'feature', scopeId: 'f1', phase: 'sharing' }),
    );
    expect(parsed).toEqual({
      type: 'context.status',
      status: { scope: 'feature', scopeId: 'f1', phase: 'sharing' },
    });
  });
});

describe('sessionLiveTotals', () => {
  it('returns zeros when nothing is recorded', () => {
    expect(sessionLiveTotals(initialLiveState, 's1')).toEqual({
      credits: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      nanoAiu: 0,
      turns: 0,
    });
  });

  it('sums only the matching session usage', () => {
    let state = applyStreamEvent(initialLiveState, {
      type: 'usage.recorded',
      usage: usage('s1', 0),
    });
    state = applyStreamEvent(state, {
      type: 'usage.recorded',
      usage: usage('s1', 1),
    });
    state = applyStreamEvent(state, {
      type: 'usage.recorded',
      usage: usage('s2', 0),
    });
    expect(sessionLiveTotals(state, 's1')).toEqual({
      credits: 2,
      cost: 1,
      inputTokens: 20,
      outputTokens: 40,
      nanoAiu: 200,
      turns: 2,
    });
  });
});

describe('resolveSessionMetrics', () => {
  const liveTotals = {
    credits: 5,
    cost: 2,
    inputTokens: 11,
    outputTokens: 22,
    nanoAiu: 999,
    turns: 3,
  };

  it('prefers the persisted rollup so rows match the persisted status bar', () => {
    const persisted = { nanoAiu: 200, inputTokens: 20, outputTokens: 40 };
    expect(resolveSessionMetrics(persisted, liveTotals)).toEqual({
      nanoAiu: 200,
      inputTokens: 20,
      outputTokens: 40,
    });
  });

  it('prefers persisted even when live totals have been observed', () => {
    // Regression: previously live SSE totals (incomplete after a reconnect)
    // were preferred over the authoritative rollup, so the explorer AIC drifted
    // away from the status-bar footer. Persisted must always win when present.
    const persisted = { nanoAiu: 200, inputTokens: 20, outputTokens: 40 };
    expect(resolveSessionMetrics(persisted, liveTotals).nanoAiu).toBe(200);
  });

  it('falls back to live totals for brand-new sessions without a rollup', () => {
    expect(resolveSessionMetrics(undefined, liveTotals)).toEqual({
      nanoAiu: 999,
      inputTokens: 11,
      outputTokens: 22,
    });
  });
});

describe('workspaceLiveTotals', () => {
  it('returns zeros when nothing is recorded', () => {
    expect(workspaceLiveTotals(initialLiveState)).toEqual({
      credits: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      nanoAiu: 0,
      turns: 0,
    });
  });

  it('sums usage across every session', () => {
    let state = applyStreamEvent(initialLiveState, {
      type: 'usage.recorded',
      usage: usage('s1', 0),
    });
    state = applyStreamEvent(state, {
      type: 'usage.recorded',
      usage: usage('s2', 0),
    });
    expect(workspaceLiveTotals(state)).toEqual({
      credits: 2,
      cost: 1,
      inputTokens: 20,
      outputTokens: 40,
      nanoAiu: 200,
      turns: 2,
    });
  });
});

describe('liveSignal', () => {
  it('is zero for the initial state', () => {
    expect(liveSignal(initialLiveState)).toBe(0);
  });

  it('increases as sessions and usage are observed', () => {
    let state = applyStreamEvent(initialLiveState, {
      type: 'session.started',
      session: session('s1'),
    });
    expect(liveSignal(state)).toBe(1);
    state = applyStreamEvent(state, {
      type: 'usage.recorded',
      usage: usage('s1', 0),
    });
    expect(liveSignal(state)).toBe(2);
  });
});
