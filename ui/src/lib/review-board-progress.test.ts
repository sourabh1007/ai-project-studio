import { describe, expect, it } from 'vitest';
import {
  applyAgentRatingChange,
  mapWithConcurrency,
  mapWithDynamicConcurrency,
  mergeAnalyzedPerspective,
  recommendationFor,
  runWithRetry,
  RetryCancelledError,
  summarizePerspectives,
} from './review-board-progress.js';
import type {
  ReviewBoard,
  ReviewBoardRatingChange,
  ReviewFinding,
  ReviewPerspective,
} from './types.js';

function finding(severity: ReviewFinding['severity']): ReviewFinding {
  return {
    id: `id-${severity}-${Math.random()}`,
    perspectiveId: 'p',
    title: 't',
    detail: 'd',
    severity,
    status: 'needs-review',
    evidence: [],
  };
}

function perspective(
  id: string,
  findings: ReviewFinding[],
): ReviewPerspective {
  return {
    id,
    name: id,
    why: 'w',
    source: 'core',
    status: 'needs-review',
    risk: 'low',
    findings,
  };
}

describe('summarizePerspectives', () => {
  it('counts findings by severity bucket', () => {
    const summary = summarizePerspectives([
      perspective('a', [finding('critical'), finding('high')]),
      perspective('b', [finding('medium'), finding('low')]),
      perspective('c', [finding('suggestion')]),
    ]);
    expect(summary).toEqual({
      open: 5,
      blocking: 2,
      warnings: 2,
      suggestions: 1,
    });
  });

  it('returns zeros for an empty board', () => {
    expect(summarizePerspectives([])).toEqual({
      open: 0,
      blocking: 0,
      warnings: 0,
      suggestions: 0,
    });
  });
});

describe('recommendationFor', () => {
  it('requests changes when there is blocking work', () => {
    expect(
      recommendationFor({ open: 1, blocking: 1, warnings: 0, suggestions: 0 }),
    ).toBe('request-changes');
  });

  it('needs review otherwise', () => {
    expect(
      recommendationFor({ open: 2, blocking: 0, warnings: 2, suggestions: 0 }),
    ).toBe('needs-review');
  });
});

describe('mergeAnalyzedPerspective', () => {
  const board: ReviewBoard = {
    featureId: 'f',
    repoId: 'r1',
    pull: { number: 1, title: 't', url: 'u' },
    worktreePath: 'w',
    baseBranch: 'main',
    changedFiles: 1,
    model: {
      projectType: 'x',
      projectTypeConfidence: 1,
      primaryLanguages: [],
      secondaryLanguages: [],
      changedComponents: [],
      changedModules: [],
      changedRuntimePaths: [],
      configurationSystems: [],
      testSignals: [],
      deploymentModel: '',
      contracts: [],
      blastRadiusDimensions: [],
      confidence: 1,
      evidence: [],
    },
    perspectives: [perspective('a', []), perspective('b', [])],
    recommendation: 'needs-review',
    summary: { open: 0, blocking: 0, warnings: 0, suggestions: 0 },
    reviewUpdatedAt: 't0',
    generatedAt: 't',
  };

  it('replaces the perspective and recomputes summary + recommendation', () => {
    const next = mergeAnalyzedPerspective(
      board,
      perspective('a', [finding('high')]),
    );
    expect(next.perspectives[0].findings).toHaveLength(1);
    expect(next.perspectives[1]).toBe(board.perspectives[1]);
    expect(next.summary.blocking).toBe(1);
    expect(next.recommendation).toBe('request-changes');
  });

  it('re-rates a perspective on an agent rating change', () => {
    const change: ReviewBoardRatingChange = {
      perspectiveId: 'a',
      status: 'blocked',
      risk: 'high',
      summary: 's',
      rationale: [{ label: 'L', detail: 'd' }],
      justification: 'j',
    };
    const next = applyAgentRatingChange(board, change);
    expect(next.perspectives[0].status).toBe('blocked');
    expect(next.perspectives[0].risk).toBe('high');
    // Findings are untouched by a rating change.
    expect(next.perspectives[0].findings).toHaveLength(0);
  });

  it('ignores an agent rating change for an unknown perspective', () => {
    const next = applyAgentRatingChange(board, {
      perspectiveId: 'ghost',
      status: 'approved',
      risk: 'low',
      summary: 's',
      rationale: [{ label: 'L', detail: 'd' }],
      justification: 'j',
    });
    expect(next).toBe(board);
  });
});

describe('mapWithConcurrency', () => {
  it('processes every item', async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty list', async () => {
    let calls = 0;
    await mapWithConcurrency([], 4, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  it('caps workers to the item count', async () => {
    const seen: string[] = [];
    await mapWithConcurrency(['only'], 8, async (s) => {
      seen.push(s);
    });
    expect(seen).toEqual(['only']);
  });
});

describe('mapWithDynamicConcurrency', () => {
  const flush = (): Promise<void> =>
    new Promise((r) => {
      setTimeout(r, 0);
    });

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  const noPoll = (): (() => void) => () => {};

  it('processes every item with a constant limit', async () => {
    const seen: number[] = [];
    await mapWithDynamicConcurrency(
      [1, 2, 3, 4, 5],
      2,
      async (n) => {
        seen.push(n);
      },
      { schedule: () => noPoll() },
    );
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('resolves immediately for an empty list without scheduling a poll', async () => {
    let scheduled = 0;
    await mapWithDynamicConcurrency([], 4, async () => {}, {
      schedule: () => {
        scheduled += 1;
        return noPoll();
      },
    });
    expect(scheduled).toBe(0);
  });

  it('spins up more workers when the limit rises mid-run', async () => {
    const started: string[] = [];
    const gates: Array<{ resolve: () => void }> = [];
    let limit = 1;
    let poll: () => void = () => {};
    let cancelPollCalls = 0;
    const run = mapWithDynamicConcurrency(
      ['a', 'b', 'c', 'd'],
      () => limit,
      async (id) => {
        started.push(id);
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
      },
      {
        pollMs: 50,
        schedule: (fn) => {
          poll = fn;
          return () => {
            cancelPollCalls += 1;
          };
        },
      },
    );
    await flush();
    expect(started).toEqual(['a']); // limit 1 → a single worker

    limit = 3;
    poll(); // freshly added capacity is picked up by the queued items
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);

    // Drain until every item (including the queued 'd') has been processed.
    for (let i = 0; i < 10 && gates.length > 0; i += 1) {
      gates.splice(0).forEach((g) => g.resolve());
      await flush();
    }
    await run;
    expect(started.slice().sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(cancelPollCalls).toBe(1); // the poll is torn down on completion

    poll(); // a late tick after completion is a no-op (already finished)
    await flush();
    expect(started.slice().sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('skips overlapping polls while a slow limit read is still in flight', async () => {
    const started: string[] = [];
    const gates: Array<{ resolve: () => void }> = [];
    let limitCalls = 0;
    let releaseLimit: () => void = () => {};
    let currentLimit = 1;
    let poll: () => void = () => {};
    const getLimit = (): Promise<number> => {
      limitCalls += 1;
      return new Promise<number>((resolve) => {
        releaseLimit = () => resolve(currentLimit);
      });
    };
    const run = mapWithDynamicConcurrency(
      ['a', 'b', 'c'],
      getLimit,
      async (id) => {
        started.push(id);
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
      },
      {
        pollMs: 10,
        schedule: (fn) => {
          poll = fn;
          return noPoll();
        },
      },
    );
    // The initial top-up reads the limit once and awaits it (call #1).
    expect(limitCalls).toBe(1);
    releaseLimit(); // resolve at limit 1 → a single worker starts on 'a'
    await flush();
    expect(started).toEqual(['a']);

    // Raise the target, then start a poll whose limit read stays pending.
    currentLimit = 3;
    poll(); // in-flight top-up reads the limit (call #2), then suspends
    expect(limitCalls).toBe(2);
    poll(); // overlapping ticks are skipped while a poll is in flight…
    poll();
    expect(limitCalls).toBe(2); // …so no extra reads pile up on the sockets

    releaseLimit(); // the single in-flight poll resolves → scales up to 3
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);

    for (let i = 0; i < 6 && gates.length > 0; i += 1) {
      gates.splice(0).forEach((g) => g.resolve());
      await flush();
    }
    await run;
    expect(started.slice().sort()).toEqual(['a', 'b', 'c']);
  });

  it('never exceeds the current limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithDynamicConcurrency(
      [1, 2, 3, 4, 5, 6],
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await flush();
        inFlight -= 1;
      },
      { schedule: () => noPoll() },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('falls back to the current worker count when the limit getter throws', async () => {
    const seen: number[] = [];
    await mapWithDynamicConcurrency(
      [1, 2],
      () => {
        throw new Error('pool status unavailable');
      },
      async (n) => {
        seen.push(n);
      },
      { schedule: () => noPoll() },
    );
    expect(seen.slice().sort()).toEqual([1, 2]);
  });

  it('stops dispatching once cancelled and settles in-flight work', async () => {
    const started: number[] = [];
    let cancelled = false;
    let poll: () => void = () => {};
    const gate = deferred();
    const run = mapWithDynamicConcurrency(
      [1, 2, 3, 4],
      1,
      async (n) => {
        started.push(n);
        if (n === 1) await gate.promise;
      },
      {
        cancelled: () => cancelled,
        schedule: (fn) => {
          poll = fn;
          return noPoll();
        },
      },
    );
    await flush();
    expect(started).toEqual([1]);

    cancelled = true;
    gate.resolve();
    await flush(); // the in-flight worker unwinds and the run settles
    poll(); // a tick after cancellation is a harmless no-op
    await run;
    expect(started).toEqual([1]); // 2, 3, 4 were never dispatched
  });

  it('dispatches nothing when cancelled before the first tick', async () => {
    const started: number[] = [];
    await mapWithDynamicConcurrency(
      [1, 2],
      2,
      async (n) => {
        started.push(n);
      },
      { cancelled: () => true, schedule: () => noPoll() },
    );
    expect(started).toEqual([]);
  });

  it('drives itself with the default interval scheduler when none is injected', async () => {
    const seen: number[] = [];
    await mapWithDynamicConcurrency([1, 2, 3], 2, async (n) => {
      seen.push(n);
      await flush();
    });
    expect(seen.slice().sort()).toEqual([1, 2, 3]);
  });
});

describe('runWithRetry', () => {
  const noDelay = async () => {};

  it('returns immediately on first success', async () => {
    const attempts: number[] = [];
    const result = await runWithRetry(
      async (attempt) => {
        attempts.push(attempt);
        return 'ok';
      },
      { attempts: 3, delay: noDelay, backoffMs: () => 10 },
    );
    expect(result).toBe('ok');
    expect(attempts).toEqual([1]);
  });

  it('heals after transient failures and reports each retry', async () => {
    const retried: number[] = [];
    const backoffs: number[] = [];
    let calls = 0;
    const result = await runWithRetry(
      async (attempt) => {
        calls += 1;
        if (attempt < 3) throw new Error(`boom ${attempt}`);
        return 'healed';
      },
      {
        attempts: 3,
        delay: async (ms) => {
          backoffs.push(ms);
        },
        backoffMs: (attempt) => attempt * 100,
        onRetry: (next) => retried.push(next),
      },
    );
    expect(result).toBe('healed');
    expect(calls).toBe(3);
    expect(retried).toEqual([2, 3]);
    expect(backoffs).toEqual([100, 200]);
  });

  it('throws the last error once attempts are exhausted', async () => {
    await expect(
      runWithRetry(
        async (attempt) => {
          throw new Error(`fail ${attempt}`);
        },
        { attempts: 2, delay: noDelay, backoffMs: () => 1 },
      ),
    ).rejects.toThrow('fail 2');
  });

  it('does not retry when shouldRetry is false', async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        async () => {
          calls += 1;
          throw new Error('permanent');
        },
        {
          attempts: 3,
          delay: noDelay,
          backoffMs: () => 1,
          shouldRetry: () => false,
        },
      ),
    ).rejects.toThrow('permanent');
    expect(calls).toBe(1);
  });

  it('cancels before the first attempt', async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        async () => {
          calls += 1;
          return 'never';
        },
        {
          attempts: 3,
          delay: noDelay,
          backoffMs: () => 1,
          cancelled: () => true,
        },
      ),
    ).rejects.toBeInstanceOf(RetryCancelledError);
    expect(calls).toBe(0);
  });

  it('stops retrying once cancelled after a failure', async () => {
    let calls = 0;
    let cancelled = false;
    await expect(
      runWithRetry(
        async () => {
          calls += 1;
          cancelled = true;
          throw new Error('boom');
        },
        {
          attempts: 3,
          delay: noDelay,
          backoffMs: () => 1,
          cancelled: () => cancelled,
        },
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  it('cancels during the backoff wait', async () => {
    let calls = 0;
    let cancelled = false;
    await expect(
      runWithRetry(
        async () => {
          calls += 1;
          throw new Error('boom');
        },
        {
          attempts: 3,
          delay: async () => {
            cancelled = true;
          },
          backoffMs: () => 1,
          cancelled: () => cancelled,
        },
      ),
    ).rejects.toBeInstanceOf(RetryCancelledError);
    expect(calls).toBe(1);
  });

  it('treats a non-positive attempt count as a single try', async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        async () => {
          calls += 1;
          throw new Error('once');
        },
        { attempts: 0, delay: noDelay, backoffMs: () => 1 },
      ),
    ).rejects.toThrow('once');
    expect(calls).toBe(1);
  });
});
