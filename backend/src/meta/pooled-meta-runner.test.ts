import { describe, it, expect, vi } from 'vitest';
import type { MetaRequest, MetaRunResult, MetaRunner } from './meta-runner.js';
import type { MetaSessionPoolStats } from './acp/acp-pool.js';
import {
  createPooledMetaRunner,
  metaPoolsStatus,
  type PurposePool,
} from './pooled-meta-runner.js';

function stats(overrides: Partial<MetaSessionPoolStats> = {}): MetaSessionPoolStats {
  return {
    size: 1,
    live: 1,
    idle: 1,
    busy: 0,
    ready: true,
    served: 0,
    sessions: [],
    ...overrides,
  };
}

function pool(
  purpose: string,
  options: {
    ready?: boolean;
    result?: MetaRunResult;
    error?: Error;
  } = {},
): PurposePool & { calls: MetaRequest[] } {
  const calls: MetaRequest[] = [];
  return {
    purpose,
    calls,
    ready: () => options.ready ?? true,
    stats: () => stats({ ready: options.ready ?? true }),
    runDetailed: async (request) => {
      calls.push(request);
      if (options.error) {
        throw options.error;
      }
      return options.result ?? { text: `warm:${purpose}`, sessionId: 'warm' };
    },
  };
}

function coldRunner(text = 'cold'): MetaRunner & { calls: MetaRequest[] } {
  const calls: MetaRequest[] = [];
  const runDetailed = vi.fn(async (request: MetaRequest) => {
    calls.push(request);
    return { text, sessionId: 'cold' };
  });
  return {
    calls,
    runDetailed,
    run: async (request) => (await runDetailed(request)).text,
  };
}

const req = (extra: Partial<MetaRequest> = {}): MetaRequest => ({
  featureId: 'f1',
  prompt: 'hi',
  ...extra,
});

describe('createPooledMetaRunner', () => {
  it('bypasses the warm pools and uses the cold path when bypass() is true', async () => {
    const general = pool('general');
    const cold = coldRunner();
    const runner = createPooledMetaRunner({
      pools: [general],
      fallback: cold,
      bypass: () => true,
    });
    const result = await runner.runDetailed(req());
    expect(result.text).toBe('cold');
    expect(cold.calls).toHaveLength(1);
    expect(general.calls).toHaveLength(0);
  });

  it('uses the warm pool when bypass() is false', async () => {
    const general = pool('general');
    const cold = coldRunner();
    const runner = createPooledMetaRunner({
      pools: [general],
      fallback: cold,
      bypass: () => false,
    });
    const result = await runner.runDetailed(req());
    expect(result.text).toBe('warm:general');
    expect(cold.calls).toHaveLength(0);
  });

  it('routes to the pool matching the request purpose', async () => {
    const review = pool('review');
    const general = pool('general');
    const runner = createPooledMetaRunner({
      pools: [general, review],
      fallback: coldRunner(),
    });
    const result = await runner.runDetailed(req({ purpose: 'review' }));
    expect(result.text).toBe('warm:review');
    expect(review.calls).toHaveLength(1);
    expect(general.calls).toHaveLength(0);
  });

  it('falls back to the general pool for an unmatched purpose', async () => {
    const general = pool('general');
    const runner = createPooledMetaRunner({
      pools: [general],
      fallback: coldRunner(),
    });
    const result = await runner.runDetailed(req({ purpose: 'unknown' }));
    expect(result.text).toBe('warm:general');
    expect(general.calls).toHaveLength(1);
  });

  it('uses the general pool when no purpose is given', async () => {
    const general = pool('general');
    const runner = createPooledMetaRunner({
      pools: [general],
      fallback: coldRunner(),
    });
    const out = await runner.run(req());
    expect(out).toBe('warm:general');
  });

  it('routes to a pool added to the live pool set after construction', async () => {
    const general = pool('general');
    const pools: Array<ReturnType<typeof pool>> = [general];
    const runner = createPooledMetaRunner({
      pools,
      fallback: coldRunner(),
    });
    // Before the pool exists, the purpose falls back to general.
    await runner.runDetailed(req({ purpose: 'review' }));
    expect(general.calls).toHaveLength(1);
    // A pool added live (as main.ts does on a Settings save) takes effect at
    // once, without rebuilding the runner.
    const review = pool('review');
    pools.push(review);
    const result = await runner.runDetailed(req({ purpose: 'review' }));
    expect(result.text).toBe('warm:review');
    expect(review.calls).toHaveLength(1);
    expect(general.calls).toHaveLength(1);
  });

  it('uses the cold runner while the pool is warming', async () => {
    const general = pool('general', { ready: false });
    const cold = coldRunner('cold-text');
    const runner = createPooledMetaRunner({ pools: [general], fallback: cold });
    const out = await runner.run(req());
    expect(out).toBe('cold-text');
    expect(general.calls).toHaveLength(0);
    expect(cold.calls).toHaveLength(1);
  });

  it('falls back to cold and reports when a warm turn throws', async () => {
    const boom = new Error('acp died');
    const general = pool('general', { error: boom });
    const cold = coldRunner('cold-text');
    const onFallback = vi.fn();
    const runner = createPooledMetaRunner({
      pools: [general],
      fallback: cold,
      onFallback,
    });
    const out = await runner.run(req());
    expect(out).toBe('cold-text');
    expect(onFallback).toHaveBeenCalledWith('general', boom);
    expect(cold.calls).toHaveLength(1);
  });

  it('falls back to cold when there is no general pool at all', async () => {
    const cold = coldRunner('cold-text');
    const runner = createPooledMetaRunner({
      pools: [pool('review', { ready: true })],
      fallback: cold,
    });
    const out = await runner.run(req({ purpose: 'other' }));
    expect(out).toBe('cold-text');
    expect(cold.calls).toHaveLength(1);
  });

  it('records demand telemetry for the routed purpose on a warm turn', async () => {
    const events: string[] = [];
    const demand = {
      begin: (purpose: string) => events.push(`begin:${purpose}`),
      end: (purpose: string) => events.push(`end:${purpose}`),
      suggestion: () => 1,
    };
    const runner = createPooledMetaRunner({
      pools: [pool('general'), pool('review')],
      fallback: coldRunner(),
      demand,
    });
    await runner.runDetailed(req({ purpose: 'review' }));
    expect(events).toEqual(['begin:review', 'end:review']);
  });

  it('records demand under general when no pool matches the purpose', async () => {
    const events: string[] = [];
    const demand = {
      begin: (purpose: string) => events.push(`begin:${purpose}`),
      end: (purpose: string) => events.push(`end:${purpose}`),
      suggestion: () => 1,
    };
    const cold = coldRunner('cold-text');
    const runner = createPooledMetaRunner({
      pools: [pool('review', { ready: true })],
      fallback: cold,
      demand,
    });
    await runner.run(req({ purpose: 'nope' }));
    // No general pool, so it spills to cold but is still counted under the
    // request's own purpose.
    expect(events).toEqual(['begin:nope', 'end:nope']);
  });

  it('ends demand even when a warm turn throws and spills to cold', async () => {    const events: string[] = [];
    const demand = {
      begin: (purpose: string) => events.push(`begin:${purpose}`),
      end: (purpose: string) => events.push(`end:${purpose}`),
      suggestion: () => 1,
    };
    const runner = createPooledMetaRunner({
      pools: [pool('general', { error: new Error('boom') })],
      fallback: coldRunner('cold-text'),
      demand,
    });
    await runner.run(req());
    expect(events).toEqual(['begin:general', 'end:general']);
  });

  it('counts demand under general when no pool and no purpose are given', async () => {
    const events: string[] = [];
    const demand = {
      begin: (purpose: string) => events.push(`begin:${purpose}`),
      end: (purpose: string) => events.push(`end:${purpose}`),
      suggestion: () => 1,
    };
    const runner = createPooledMetaRunner({
      pools: [pool('review', { ready: true })],
      fallback: coldRunner('cold-text'),
      demand,
    });
    await runner.run(req());
    expect(events).toEqual(['begin:general', 'end:general']);
  });
});

describe('metaPoolsStatus', () => {
  it('projects each pool into a status entry', () => {
    const status = metaPoolsStatus(true, [
      { purpose: 'general', stats: () => stats({ idle: 4, live: 5, size: 5, served: 7 }) },
      {
        purpose: 'review',
        stats: () => stats({ ready: false, idle: 0, live: 0, size: 2, busy: 0 }),
      },
    ]);
    expect(status).toEqual({
      enabled: true,
      pools: [
        {
          purpose: 'general',
          suggestedSize: 5,
          size: 5,
          live: 5,
          idle: 4,
          busy: 0,
          ready: true,
          served: 7,
          sessions: [],
        },
        {
          purpose: 'review',
          suggestedSize: 2,
          size: 2,
          live: 0,
          idle: 0,
          busy: 0,
          ready: false,
          served: 0,
          sessions: [],
        },
      ],
    });
  });

  it('uses the demand telemetry to suggest a warm size when provided', () => {
    const status = metaPoolsStatus(
      true,
      [{ purpose: 'general', stats: () => stats({ size: 5 }) }],
      { suggestion: (purpose) => (purpose === 'general' ? 8 : 1) },
    );
    expect(status.pools[0].suggestedSize).toBe(8);
  });

  it('includes the model powering warm sessions when provided', () => {
    const status = metaPoolsStatus(
      true,
      [{ purpose: 'general', stats: () => stats({ size: 5 }) }],
      undefined,
      'claude-opus-4.8',
    );
    expect(status.model).toBe('claude-opus-4.8');
  });

  it('omits the model key when it is unknown', () => {
    const status = metaPoolsStatus(true, [
      { purpose: 'general', stats: () => stats({ size: 5 }) },
    ]);
    expect('model' in status).toBe(false);
  });
});
