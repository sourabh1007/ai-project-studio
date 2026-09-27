import { describe, expect, it } from 'vitest';
import { resourcePressureConfigSchema, resourcePressureDefaults as config } from './config.js';
import { cpuUtilization, evaluateResources, type ResourceReading } from './resource-pressure.js';

const normal: ResourceReading = {
  measuredAt: 10_000, cpuPercent: 20,
  freeMemoryBytes: 8e9, totalMemoryBytes: 16e9, eventLoopDelayMs: 20,
};

describe('measured resource pressure', () => {
  it('validates config defaults and expiry interval', () => {
    expect(resourcePressureConfigSchema.parse(config)).toEqual(config);
    expect(resourcePressureConfigSchema.safeParse({ ...config, staleAfterMs: 1 }).success).toBe(false);
  });
  it('reports normal actual measurements', () => {
    expect(evaluateResources(normal, 10_001, config)).toEqual({
      ...normal, status: 'normal', reasons: [], staleAfterMs: config.staleAfterMs,
    });
  });
  it.each([
    [{ cpuPercent: 90 }, 'high-cpu'],
    [{ freeMemoryBytes: 1.6e9 }, 'low-memory'],
    [{ eventLoopDelayMs: 250 }, 'event-loop-lag'],
  ] as const)('evaluates threshold %s', (patch, reason) => {
    expect(evaluateResources({ ...normal, ...patch }, 10_000, config)).toMatchObject({
      status: 'pressure', reasons: [reason],
    });
  });
  it('reports all measured causes and clears pressure on recovery', () => {
    expect(evaluateResources({
      ...normal, cpuPercent: 99, freeMemoryBytes: 0, eventLoopDelayMs: 1_000,
    }, 10_000, config).reasons).toEqual(['high-cpu', 'low-memory', 'event-loop-lag']);
    expect(evaluateResources(normal, 10_000, config).status).toBe('normal');
  });
  it('expires stale and missing measurements without retaining pressure', () => {
    for (const reading of [undefined, { ...normal, cpuPercent: 99 }]) {
      expect(evaluateResources(reading, 40_000, config)).toMatchObject({
        status: 'unknown', reasons: [], measuredAt: null, cpuPercent: null,
      });
    }
    expect(evaluateResources(normal, 39_999, config).status).toBe('normal');
    expect(evaluateResources(normal, 9_999, config).status).toBe('unknown');
  });
  it.each([
    { cpuPercent: Number.NaN }, { cpuPercent: -1 }, { cpuPercent: 101 },
    { totalMemoryBytes: 0 }, { freeMemoryBytes: -1 },
    { freeMemoryBytes: 17e9 }, { eventLoopDelayMs: -1 },
  ])('rejects invalid measurements %s', (patch) => {
    expect(evaluateResources({ ...normal, ...patch }, 10_000, config).status).toBe('unknown');
  });
  it('computes CPU from deltas and rejects unavailable/reset counters', () => {
    expect(cpuUtilization({ idle: 10, total: 20 }, { idle: 30, total: 120 })).toBe(80);
    expect(cpuUtilization({ idle: 10, total: 20 }, { idle: 10, total: 20 })).toBeNaN();
    expect(cpuUtilization({ idle: 10, total: 20 }, { idle: 9, total: 120 })).toBeNaN();
    expect(cpuUtilization({ idle: 10, total: 20 }, { idle: 200, total: 120 })).toBeNaN();
  });
});
