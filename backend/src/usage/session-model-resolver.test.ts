import { describe, expect, it } from 'vitest';
import { createSessionModelResolver } from './session-model-resolver.js';
import type { Session } from '../session/session-contract.js';
import type { StoredUsage } from './usage-repo-port.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    featureId: 'f1',
    name: null,
    provider: 'agency',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'running',
    kind: 'dev',
    prompt: 'go',
    usageFilePath: 'usage.jsonl',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function usage(overrides: Partial<StoredUsage> = {}): StoredUsage {
  return {
    sessionId: 's1',
    featureId: 'f1',
    turnIndex: 0,
    provider: 'agency',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5',
    operation: 'chat',
    inputTokens: 1,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    cost: 3,
    credits: 3,
    nanoAiu: 3_000_000_000,
    kind: 'dev',
    serviceRequestId: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

describe('createSessionModelResolver', () => {
  it('updates from newer usage chronology and allows correcting the current latest row', () => {
    const saved: Session[] = [];
    let current = session({ resolvedModel: 'gpt-5' });
    const resolver = createSessionModelResolver({
      sessions: {
        get: () => current,
        save: (next) => {
          current = next;
          saved.push(next);
        },
      },
      usage: {
        listBySession: () => [usage()],
      },
      publish: (next) => saved.push(next),
    });

    resolver.observeUsage(
      usage({
        turnIndex: 1,
        startedAt: '2026-01-01T00:01:00.000Z',
        endedAt: '2026-01-01T00:01:01.000Z',
        resolvedModel: 'claude-sonnet-5',
      }),
    );
    resolver.observeUsage(
      usage({
        turnIndex: 1,
        startedAt: '2026-01-01T00:01:00.000Z',
        endedAt: '2026-01-01T00:01:01.000Z',
        resolvedModel: 'claude-opus-5',
      }),
    );

    expect(current.resolvedModel).toBe('claude-opus-5');
    expect(saved.filter((item) => item.resolvedModel === 'claude-sonnet-5')).toHaveLength(2);
    expect(saved.filter((item) => item.resolvedModel === 'claude-opus-5')).toHaveLength(2);
  });

  it('ignores an older corrected usage row once a newer row is already current', () => {
    const published: Session[] = [];
    let current = session({ resolvedModel: 'claude-sonnet-5' });
    const resolver = createSessionModelResolver({
      sessions: {
        get: () => current,
        save: (next) => {
          current = next;
        },
      },
      usage: {
        listBySession: () => [
          usage({ resolvedModel: 'gpt-5', startedAt: '2026-01-01T00:00:00.000Z' }),
          usage({
            turnIndex: 1,
            resolvedModel: 'claude-sonnet-5',
            startedAt: '2026-01-01T00:01:00.000Z',
            endedAt: '2026-01-01T00:01:01.000Z',
          }),
        ],
      },
      publish: (next) => published.push(next),
    });

    resolver.observeUsage(
      usage({
        resolvedModel: 'gpt-4.1',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:01.000Z',
      }),
    );

    expect(current.resolvedModel).toBe('claude-sonnet-5');
    expect(published).toEqual([]);
  });

  it('does not let a historical correction regress the current model after a newer row became current', () => {
    const published: Session[] = [];
    let current = session({ resolvedModel: 'claude-opus-5' });
    const resolver = createSessionModelResolver({
      sessions: {
        get: () => current,
        save: (next) => {
          current = next;
        },
      },
      usage: {
        listBySession: () => [
          usage({ resolvedModel: 'gpt-5', startedAt: '2026-01-01T00:00:00.000Z' }),
          usage({
            turnIndex: 2,
            resolvedModel: 'claude-opus-5',
            startedAt: '2026-01-01T00:02:00.000Z',
            endedAt: '2026-01-01T00:02:01.000Z',
          }),
        ],
      },
      publish: (next) => published.push(next),
    });

    resolver.observeUsage(
      usage({
        turnIndex: 0,
        resolvedModel: 'gpt-4.1',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:02.000Z',
      }),
    );

    expect(current.resolvedModel).toBe('claude-opus-5');
    expect(published).toEqual([]);
  });

  it('lets authoritative active-provider updates win over same-or-older replayed usage until newer usage arrives', () => {
    const published: Session[] = [];
    let current = session({ resolvedModel: 'gpt-5' });
    const resolver = createSessionModelResolver({
      sessions: {
        get: () => current,
        save: (next) => {
          current = next;
        },
      },
      usage: {
        listBySession: () => [usage()],
      },
      publish: (next) => published.push(next),
    });

    resolver.observeAuthoritative('s1', 'claude-sonnet-5');
    resolver.observeUsage(
      usage({
        resolvedModel: 'gpt-4.1',
        startedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    resolver.observeUsage(
      usage({
        turnIndex: 1,
        resolvedModel: 'claude-opus-5',
        startedAt: '2026-01-01T00:02:00.000Z',
        endedAt: '2026-01-01T00:02:01.000Z',
      }),
    );

    expect(current.resolvedModel).toBe('claude-opus-5');
    expect(published.map((item) => item.resolvedModel)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5',
    ]);
  });

  it('seeds from the first observed usage when no prior usage exists and skips duplicate writes', () => {
    const published: Session[] = [];
    let current = session({ resolvedModel: null });
    const resolver = createSessionModelResolver({
      sessions: {
        get: () => current,
        save: (next) => {
          current = next;
        },
      },
      usage: {
        listBySession: () => [],
      },
      publish: (next) => published.push(next),
    });

    resolver.observeUsage(
      usage({
        resolvedModel: 'claude-sonnet-5',
        startedAt: '2026-01-01T00:03:00.000Z',
        endedAt: '2026-01-01T00:03:01.000Z',
      }),
    );
    resolver.observeUsage(
      usage({
        resolvedModel: 'claude-sonnet-5',
        startedAt: '2026-01-01T00:03:00.000Z',
        endedAt: '2026-01-01T00:03:01.000Z',
      }),
    );

    expect(current.resolvedModel).toBe('claude-sonnet-5');
    expect(published.map((item) => item.resolvedModel)).toEqual(['claude-sonnet-5']);
  });

  it('ignores updates for missing sessions and still tracks authoritative locks without publishing', () => {
    const published: Session[] = [];
    const resolver = createSessionModelResolver({
      sessions: {
        get: () => null,
        save: () => {
          throw new Error('should not save missing sessions');
        },
      },
      usage: {
        listBySession: () => [],
      },
      publish: (next) => published.push(next),
    });

    resolver.observeAuthoritative('missing', 'claude-sonnet-5');
    resolver.observeUsage(
      usage({
        sessionId: 'missing',
        resolvedModel: 'gpt-4.1',
        startedAt: '2026-01-01T00:04:00.000Z',
        endedAt: '2026-01-01T00:04:01.000Z',
      }),
    );

    expect(published).toEqual([]);
  });

  it('orders usage with identical timestamps by turn index', () => {
    const published: Session[] = [];
    let current = session({ resolvedModel: 'gpt-5' });
    const resolver = createSessionModelResolver({
      sessions: {
        get: () => current,
        save: (next) => {
          current = next;
        },
      },
      usage: {
        listBySession: () => [usage()],
      },
      publish: (next) => published.push(next),
    });

    resolver.observeUsage(
      usage({
        turnIndex: 1,
        resolvedModel: 'claude-sonnet-5',
      }),
    );
    resolver.observeUsage(
      usage({
        turnIndex: 0,
        resolvedModel: 'gpt-4.1',
      }),
    );

    expect(current.resolvedModel).toBe('claude-sonnet-5');
    expect(published.map((item) => item.resolvedModel)).toEqual(['claude-sonnet-5']);
  });
});
