import { describe, it, expect, vi } from 'vitest';
import { AcpRequestError } from './acp/acp-client.js';
import type { MetaRequest, MetaRunResult, MetaRunner } from './meta-runner.js';
import type { MetaSessionPoolStats } from './acp/acp-pool.js';
import {
  createPooledMetaRunner,
  metaPoolsStatus,
  type WarmPool,
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
  options: {
    ready?: boolean;
    result?: MetaRunResult;
    error?: unknown;
  } = {},
): WarmPool & { calls: MetaRequest[] } {
  const calls: MetaRequest[] = [];
  return {
    calls,
    ready: () => options.ready ?? true,
    stats: () => stats({ ready: options.ready ?? true }),
    runDetailed: async (request) => {
      calls.push(request);
      if (options.error !== undefined) {
        throw options.error;
      }
      return options.result ?? { text: 'warm', sessionId: 'warm' };
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

/** Records begin/end so a test can assert demand is always balanced. */
function demandRecorder() {
  const events: string[] = [];
  return {
    events,
    begin: () => events.push('begin'),
    end: () => events.push('end'),
    suggestion: () => 1,
  };
}

describe('createPooledMetaRunner', () => {
  it('bypasses the warm pool and uses the cold path when bypass() is true', async () => {
    const warm = pool();
    const cold = coldRunner();
    const runner = createPooledMetaRunner({
      pool: warm,
      defaultTimeoutMs: 100,
      fallback: cold,
      bypass: () => true,
    });
    const result = await runner.runDetailed(req());
    expect(result.text).toBe('cold');
    expect(cold.calls).toHaveLength(1);
    expect(warm.calls).toHaveLength(0);
  });

  it('stamps a single deadline before bypassing to the cold path', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const cold = coldRunner();
      const runner = createPooledMetaRunner({
        pool: pool(),
        defaultTimeoutMs: 100,
        fallback: cold,
        bypass: () => true,
      });
      await runner.runDetailed(req({ timeoutMs: 25 }));
      expect(cold.calls[0]?.deadlineAt).toBe(Date.now() + 25);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stamps a single default deadline even when the request omits timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const cold = coldRunner();
      const runner = createPooledMetaRunner({
        pool: pool(),
        defaultTimeoutMs: 75,
        fallback: cold,
        bypass: () => true,
      });
      await runner.runDetailed(req());
      expect(cold.calls[0]?.timeoutMs).toBe(75);
      expect(cold.calls[0]?.deadlineAt).toBe(Date.now() + 75);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the warm pool when bypass() is false', async () => {
    const warm = pool();
    const cold = coldRunner();
    const runner = createPooledMetaRunner({
      pool: warm,
      defaultTimeoutMs: 100,
      fallback: cold,
      bypass: () => false,
    });
    const result = await runner.runDetailed(req());
    expect(result.text).toBe('warm');
    expect(cold.calls).toHaveLength(0);
  });

  it('serves every purpose from the one shared pool', async () => {
    const warm = pool();
    const runner = createPooledMetaRunner({
      pool: warm,
      defaultTimeoutMs: 100,
      fallback: coldRunner(),
    });
    expect(await runner.run(req({ purpose: 'review' }))).toBe('warm');
    expect(await runner.run(req({ purpose: 'self-recovery' }))).toBe('warm');
    expect(await runner.run(req())).toBe('warm');
    expect(warm.calls).toHaveLength(3);
  });

  it('uses the cold runner while the pool is warming', async () => {
    const warm = pool({ ready: false });
    const cold = coldRunner('cold-text');
    const runner = createPooledMetaRunner({
      pool: warm,
      defaultTimeoutMs: 100,
      fallback: cold,
    });
    const out = await runner.run(req());
    expect(out).toBe('cold-text');
    expect(warm.calls).toHaveLength(0);
    expect(cold.calls).toHaveLength(1);
  });

  it('does not start warm or cold execution when the request is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const warm = pool();
    const cold = coldRunner('cold-text');
    const runner = createPooledMetaRunner({
      pool: warm,
      defaultTimeoutMs: 100,
      fallback: cold,
    });
    await expect(
      runner.run({
        featureId: 'f1',
        prompt: 'hi',
        signal: controller.signal,
      }),
    ).rejects.toThrow('Meta request cancelled before it started');
    expect(warm.calls).toHaveLength(0);
    expect(cold.calls).toHaveLength(0);
  });

  it('routes incompatible warm requests to cold before execution', async () => {
    const warm = pool();
    const cold = coldRunner('cold-text');
    const runner = createPooledMetaRunner({
      pool: warm,
      defaultTimeoutMs: 100,
      fallback: cold,
      supportsWarm: (request) => !request.noTools && (request.attachments?.length ?? 0) === 0,
    });
    const out = await runner.run({
      featureId: 'f1',
      prompt: 'hi',
      noTools: true,
      attachments: ['C:\\repo\\prompt.md'],
    });
    expect(out).toBe('cold-text');
    expect(warm.calls).toHaveLength(0);
    expect(cold.calls).toHaveLength(1);
  });

  it('falls back to cold only for an explicit definite pre-dispatch ACP error', async () => {
    const boom = new AcpRequestError('session/new failed', {
      method: 'session/new',
      allowFallbackToCold: true,
    });
    const cold = coldRunner('cold-text');
    const onFallback = vi.fn();
    const runner = createPooledMetaRunner({
      pool: pool({ error: boom }),
      defaultTimeoutMs: 100,
      fallback: cold,
      onFallback,
    });
    const out = await runner.run(req());
    expect(out).toBe('cold-text');
    expect(onFallback).toHaveBeenCalledWith(boom);
    expect(cold.calls).toHaveLength(1);
  });

  it('preserves the original absolute deadline when warm pre-dispatch fallback occurs', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const boom = new AcpRequestError('session/new failed', {
        method: 'session/new',
        allowFallbackToCold: true,
      });
      const warm = pool({ error: boom });
      const cold = coldRunner('cold-text');
      const runner = createPooledMetaRunner({
        pool: warm,
        defaultTimeoutMs: 100,
        fallback: cold,
      });
      const deadlineAt = Date.now() + 50;
      await runner.run(req({ deadlineAt, timeoutMs: 100 }));
      expect(warm.calls[0]?.deadlineAt).toBe(deadlineAt);
      expect(cold.calls[0]?.deadlineAt).toBe(deadlineAt);
      expect(cold.calls[0]?.timeoutMs).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fall back to cold when the warm failure reports an ambiguous dispatched turn', async () => {
    const boom = new AcpRequestError('prompt timed out', {
      method: 'session/prompt',
      allowFallbackToCold: false,
    });
    const cold = coldRunner('cold-text');
    const onFallback = vi.fn();
    const runner = createPooledMetaRunner({
      pool: pool({ error: boom }),
      defaultTimeoutMs: 100,
      fallback: cold,
      onFallback,
    });
    await expect(runner.run(req())).rejects.toThrow('prompt timed out');
    expect(onFallback).not.toHaveBeenCalled();
    expect(cold.calls).toHaveLength(0);
  });

  it('does not fall back to cold on an unknown Error from warm execution', async () => {
    const cold = coldRunner('cold-text');
    const runner = createPooledMetaRunner({
      pool: pool({ error: new Error('unknown warm failure') }),
      defaultTimeoutMs: 100,
      fallback: cold,
    });
    await expect(runner.run(req())).rejects.toThrow('unknown warm failure');
    expect(cold.calls).toHaveLength(0);
  });

  it('does not fall back to cold on a non-Error warm failure value', async () => {
    const warm = pool();
    warm.runDetailed = async () => {
      throw 'string failure';
    };
    const cold = coldRunner('cold-text');
    const runner = createPooledMetaRunner({
      pool: warm,
      defaultTimeoutMs: 100,
      fallback: cold,
    });
    await expect(runner.run(req())).rejects.toBe('string failure');
    expect(cold.calls).toHaveLength(0);
  });

  it('records demand telemetry around a warm turn', async () => {
    const demand = demandRecorder();
    const runner = createPooledMetaRunner({
      pool: pool(),
      defaultTimeoutMs: 100,
      fallback: coldRunner(),
      demand,
    });
    await runner.runDetailed(req({ purpose: 'review' }));
    expect(demand.events).toEqual(['begin', 'end']);
  });

  it('records demand for a turn that spills to cold while the pool warms', async () => {
    const demand = demandRecorder();
    const runner = createPooledMetaRunner({
      pool: pool({ ready: false }),
      defaultTimeoutMs: 100,
      fallback: coldRunner('cold-text'),
      demand,
    });
    await runner.run(req());
    expect(demand.events).toEqual(['begin', 'end']);
  });

  it('ends demand even when a warm turn throws and spills to cold', async () => {
    const demand = demandRecorder();
    const runner = createPooledMetaRunner({
      pool: pool({
        error: new AcpRequestError('session/new failed', {
          method: 'session/new',
          allowFallbackToCold: true,
        }),
      }),
      defaultTimeoutMs: 100,
      fallback: coldRunner('cold-text'),
      demand,
    });
    await runner.run(req());
    expect(demand.events).toEqual(['begin', 'end']);
  });

  it('ends demand even when an ambiguous warm failure is rethrown', async () => {
    const demand = demandRecorder();
    const runner = createPooledMetaRunner({
      pool: pool({
        error: new AcpRequestError('timed out', {
          method: 'session/prompt',
          allowFallbackToCold: false,
        }),
      }),
      defaultTimeoutMs: 100,
      fallback: coldRunner('cold-text'),
      demand,
    });
    await expect(runner.run(req())).rejects.toThrow('timed out');
    expect(demand.events).toEqual(['begin', 'end']);
  });
});

describe('metaPoolsStatus', () => {
  it('projects the shared pool into a status entry', () => {
    expect(
      metaPoolsStatus(true, {
        stats: () => stats({ idle: 4, live: 5, size: 5, served: 7 }),
      }),
    ).toEqual({
      enabled: true,
      pool: {
        suggestedSize: 5,
        size: 5,
        live: 5,
        idle: 4,
        busy: 0,
        ready: true,
        served: 7,
        sessions: [],
      },
    });
  });

  it('uses the demand telemetry to suggest a warm size when provided', () => {
    const status = metaPoolsStatus(
      true,
      { stats: () => stats({ size: 5 }) },
      { suggestion: () => 8 },
    );
    expect(status.pool?.suggestedSize).toBe(8);
  });

  it('includes the model powering warm sessions when provided', () => {
    const status = metaPoolsStatus(
      true,
      { stats: () => stats({ size: 5 }) },
      undefined,
      'claude-opus-4.8',
    );
    expect(status.model).toBe('claude-opus-4.8');
  });

  it('omits the model key when it is unknown', () => {
    const status = metaPoolsStatus(true, { stats: () => stats({ size: 5 }) });
    expect('model' in status).toBe(false);
  });

  it('reports no pool when warm pools are disabled', () => {
    expect(metaPoolsStatus(false)).toEqual({ enabled: false });
  });

  it('still reports the model when disabled and no pool exists', () => {
    expect(metaPoolsStatus(false, undefined, undefined, 'auto')).toEqual({
      enabled: false,
      model: 'auto',
    });
  });
});
