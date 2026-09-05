import { describe, it, expect } from 'vitest';
import { createPlanUsageService } from './plan-usage-service.js';
import type { PlanUsageProbe } from './plan-usage-contract.js';

const PANEL = '2% used 25,000 / 1,000,000 AIC';

function fakeProbe(captures: Array<string | null>): {
  probe: PlanUsageProbe;
  calls: () => number;
} {
  let i = 0;
  let calls = 0;
  return {
    calls: () => calls,
    probe: {
      capture: async () => {
        calls += 1;
        return captures[Math.min(i++, captures.length - 1)];
      },
    },
  };
}

function clock(startMs: number) {
  let t = startMs;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('plan-usage-service', () => {
  it('captures on first read and caches the parsed snapshot', async () => {
    const { probe, calls } = fakeProbe([PANEL]);
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });

    const first = await svc.read();
    expect(first?.usedAic).toBe(25000);
    expect(first?.totalAic).toBe(1000000);
    expect(first?.capturedAt).toBe(new Date(0).toISOString());

    const second = await svc.read();
    expect(second).toEqual(first);
    expect(calls()).toBe(1); // served from cache, no second probe
  });

  it('returns the stale snapshot immediately and refreshes in the background', async () => {
    const { probe, calls } = fakeProbe([PANEL, '10% used 100,000 / 1,000,000 AIC']);
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });

    await svc.read();
    c.advance(2000); // expire the cache

    const stale = await svc.read();
    expect(stale?.usedAic).toBe(25000); // old value returned right away
    await new Promise((r) => setImmediate(r)); // let background refresh settle
    expect(calls()).toBe(2);

    const refreshed = await svc.read();
    expect(refreshed?.usedAic).toBe(100000);
  });

  it('single-flights overlapping captures', async () => {
    const { probe, calls } = fakeProbe([PANEL]);
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });

    const [a, b] = await Promise.all([svc.refresh(), svc.refresh()]);
    expect(a).toEqual(b);
    expect(calls()).toBe(1);
  });

  it('retains the cache when a later probe yields no text', async () => {
    const { probe } = fakeProbe([PANEL, null]);
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });

    await svc.read();
    c.advance(2000);
    const result = await svc.refresh();
    expect(result?.usedAic).toBe(25000); // previous snapshot kept
  });

  it('retains the cache when a later probe yields unparseable text', async () => {
    const { probe } = fakeProbe([PANEL, 'garbage with no credits']);
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });

    await svc.read();
    const result = await svc.refresh();
    expect(result?.usedAic).toBe(25000);
  });

  it('returns null when the very first probe yields no data', async () => {
    const { probe } = fakeProbe([null]);
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });
    expect(await svc.read()).toBeNull();
  });

  it('returns null when the first probe text is unparseable', async () => {
    const { probe } = fakeProbe(['nothing useful']);
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });
    expect(await svc.read()).toBeNull();
  });
});
