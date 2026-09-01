import { describe, it, expect, vi } from 'vitest';
import type { MetaRequest, MetaRunResult, MetaRunner } from './meta-runner.js';
import type { MetaSessionPoolStats } from './acp/acp-pool.js';
import {
  createPooledMetaRunner,
  metaPoolsStatus,
  type PurposePool,
} from './pooled-meta-runner.js';

function stats(overrides: Partial<MetaSessionPoolStats> = {}): MetaSessionPoolStats {
  return { size: 1, live: 1, idle: 1, busy: 0, ready: true, ...overrides };
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
});

describe('metaPoolsStatus', () => {
  it('projects each pool into a status entry', () => {
    const status = metaPoolsStatus(true, [
      { purpose: 'general', stats: () => stats({ idle: 4, live: 5, size: 5 }) },
      {
        purpose: 'review',
        stats: () => stats({ ready: false, idle: 0, live: 0, size: 2, busy: 0 }),
      },
    ]);
    expect(status).toEqual({
      enabled: true,
      pools: [
        { purpose: 'general', size: 5, live: 5, idle: 4, busy: 0, ready: true },
        { purpose: 'review', size: 2, live: 0, idle: 0, busy: 0, ready: false },
      ],
    });
  });
});
