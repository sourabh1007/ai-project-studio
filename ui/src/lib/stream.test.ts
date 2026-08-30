import { describe, expect, it } from 'vitest';
import type { PrReview, PrReviewStepStatus, RepositoryContext, Session, StoredUsage, Automation, Subagent } from './types.js';
import {
  applyStreamEvent,
  initialLiveState,
  liveSignal,
  parseServerEvent,
  resolveSessionMetrics,
  reviewBoardActivityLines,
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

function prReview(status: PrReviewStepStatus): PrReview {
  const step = {
    status,
    metaSessionId: status === 'pending' ? null : 'meta1',
    usage: null,
    failure: null,
    activity: [],
    generatedAt: status === 'ready' ? '2025-01-01T00:00:01Z' : null,
  };
  return {
    featureId: 'f1',
    repoId: 'r1',
    pull: { number: 7, title: 'Add retry', url: 'https://example.com/pr/7' },
    worktreePath: 'C:\\wt',
    baseBranch: 'main',
    description: 'Adds retry to the client.',
    problemStatement: {
      ...step,
      content: status === 'ready' ? 'Requests are not retried.' : null,
      sufficient: true,
    },
    changeGraph: {
      ...step,
      projects:
        status === 'ready'
          ? [{ id: 'src/App.csproj', name: 'App', path: 'src/App.csproj' }]
          : [],
      nodes:
        status === 'ready'
          ? [
              {
                path: 'src/client.ts',
                projectId: 'src/App.csproj',
                module: 'Core',
                category: 'code',
                kind: 'changed',
                changeKind: 'modified',
                diff: '',
                whatItDoes: 'HTTP client wrapper.',
                whatChanged: 'Adds retry logic.',
                review: ['Looks correct.'],
              },
            ]
          : [],
      edges: [],
    },
    changedFiles: status === 'ready' ? 3 : null,
    timestamps: {
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:01Z',
    },
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

  it('parses session.file', () => {
    const event = parseServerEvent(
      'session.file',
      JSON.stringify({ sessionId: 's1' }),
    );
    expect(event).toEqual({ type: 'session.file', sessionId: 's1' });
  });

  it('parses an error session.notice', () => {
    const event = parseServerEvent(
      'session.notice',
      JSON.stringify({ sessionId: 's1', level: 'error', message: 'boom' }),
    );
    expect(event).toEqual({
      type: 'session.notice',
      sessionId: 's1',
      level: 'error',
      message: 'boom',
    });
  });

  it('defaults an unknown session.notice level to info', () => {
    const event = parseServerEvent(
      'session.notice',
      JSON.stringify({ sessionId: 's1', message: 'fyi' }),
    );
    expect(event).toEqual({
      type: 'session.notice',
      sessionId: 's1',
      level: 'info',
      message: 'fyi',
    });
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

  it('counts session.file events per session (live Files refresh signal)', () => {
    let state = applyStreamEvent(initialLiveState, {
      type: 'session.file',
      sessionId: 's1',
    });
    expect(state.fileChangesBySession['s1']).toBe(1);
    state = applyStreamEvent(state, { type: 'session.file', sessionId: 's1' });
    state = applyStreamEvent(state, { type: 'session.file', sessionId: 's2' });
    expect(state.fileChangesBySession['s1']).toBe(2);
    expect(state.fileChangesBySession['s2']).toBe(1);
  });

  it('leaves live state unchanged for a session.notice (status-bar only)', () => {
    const state = applyStreamEvent(initialLiveState, {
      type: 'session.notice',
      sessionId: 's1',
      level: 'error',
      message: 'boom',
    });
    expect(state).toBe(initialLiveState);
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
    expect(state.prReviews['f1'].changeGraph.status).toBe('ready');
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

  it('parses and applies automation.updated then automation.removed', () => {
    const automation: Automation = {
      id: 'a1',
      name: 'Watch',
      mode: 'long',
      status: 'active',
      origin: { sessionId: null, featureId: null },
      check: { type: 'shell', command: 'echo' },
      condition: { type: 'always' },
      action: { type: 'report', prompt: 'go' },
      intervalMs: 60000,
      maxRuns: null,
      runCount: 0,
      progress: null,
      plannedSteps: [],
      lastOccurrenceKey: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      lastCheckedAt: null,
      nextRunAt: null,
      failure: null,
    };
    const parsed = parseServerEvent(
      'automation.updated',
      JSON.stringify(automation),
    );
    expect(parsed).toEqual({ type: 'automation.updated', automation });
    let state = applyStreamEvent(initialLiveState, {
      type: 'automation.updated',
      automation,
    });
    expect(state.automations['a1']).toEqual(automation);
    const removed = parseServerEvent(
      'automation.removed',
      JSON.stringify({ id: 'a1' }),
    );
    expect(removed).toEqual({ type: 'automation.removed', id: 'a1' });
    state = applyStreamEvent(state, { type: 'automation.removed', id: 'a1' });
    expect(state.automations['a1']).toBeUndefined();
  });

  it('parses and applies subagent.updated', () => {
    const subagent: Subagent = {
      id: 'g1',
      automationId: 'a1',
      origin: { sessionId: null, featureId: null },
      task: 'Analyze',
      status: 'running',
      progress: null,
      result: null,
      sessionId: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    };
    const parsed = parseServerEvent(
      'subagent.updated',
      JSON.stringify(subagent),
    );
    expect(parsed).toEqual({ type: 'subagent.updated', subagent });
    const state = applyStreamEvent(initialLiveState, {
      type: 'subagent.updated',
      subagent,
    });
    expect(state.subagents['g1']).toEqual(subagent);
  });

  it('parses and accumulates review-board activity, resetting on a new session', () => {
    const parsed = parseServerEvent(
      'review.board.activity',
      JSON.stringify({
        featureId: 'f1',
        perspectiveId: 'security',
        sessionId: 'm1',
        line: 'Reading svc/cache.cs…',
      }),
    );
    expect(parsed).toEqual({
      type: 'review.board.activity',
      activity: {
        featureId: 'f1',
        perspectiveId: 'security',
        sessionId: 'm1',
        line: 'Reading svc/cache.cs…',
      },
    });
    let state = applyStreamEvent(initialLiveState, parsed!);
    state = applyStreamEvent(state, {
      type: 'review.board.activity',
      activity: {
        featureId: 'f1',
        perspectiveId: 'security',
        sessionId: 'm1',
        line: 'Assessing BuildKey…',
      },
    });
    // Same session id → lines accumulate in order.
    expect(reviewBoardActivityLines(state, 'f1', 'security')).toEqual([
      'Reading svc/cache.cs…',
      'Assessing BuildKey…',
    ]);
    // A different perspective keeps its own independent buffer.
    expect(reviewBoardActivityLines(state, 'f1', 'impact')).toEqual([]);
    // A new metasession id (fresh run/attempt) resets the buffer.
    state = applyStreamEvent(state, {
      type: 'review.board.activity',
      activity: {
        featureId: 'f1',
        perspectiveId: 'security',
        sessionId: 'm2',
        line: 'Restarting review…',
      },
    });
    expect(reviewBoardActivityLines(state, 'f1', 'security')).toEqual([
      'Restarting review…',
    ]);
  });

  it('caps accumulated activity lines to the trailing window', () => {
    let state = initialLiveState;
    for (let i = 0; i < 80; i += 1) {
      state = applyStreamEvent(state, {
        type: 'review.board.activity',
        activity: {
          featureId: 'f1',
          perspectiveId: 'security',
          sessionId: 'm1',
          line: `line ${i}`,
        },
      });
    }
    const lines = reviewBoardActivityLines(state, 'f1', 'security');
    expect(lines).toHaveLength(60);
    expect(lines[0]).toBe('line 20');
    expect(lines[59]).toBe('line 79');
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
