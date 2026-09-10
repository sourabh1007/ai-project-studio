import { describe, it, expect } from 'vitest';
import { createPlanUsageService } from './plan-usage-service.js';
import type { PlanUsageProbe } from './plan-usage-contract.js';

const PANEL = '2% used 25,000 / 1,000,000 AIC';

function fakeProbe(captures: Array<string | null | Error>): {
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
        const next = captures[Math.min(i++, captures.length - 1)];
        if (next instanceof Error) {
          throw next;
        }
        return next;
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

/** Lets the fire-and-forget background capture settle. */
const settle = () => new Promise((r) => setImmediate(r));

describe('plan-usage-service', () => {
  it('never blocks the first read on a capture that takes tens of seconds', async () => {
    // The regression this guards: awaiting the probe held `GET /usage/plan`
    // open past the UI's request timeout, so the status bar silently showed
    // nothing at all.
    let release: (text: string) => void = () => {};
    const probe: PlanUsageProbe = {
      capture: () => new Promise<string>((r) => { release = r; }),
    };
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });

    expect(svc.read()).toEqual({ status: 'capturing', usage: null, error: null });

    release(PANEL);
    await settle();
    const ready = svc.read();
    expect(ready.status).toBe('ready');
    expect(ready.usage?.usedAic).toBe(25000);
    expect(ready.usage?.totalAic).toBe(1000000);
    expect(ready.usage?.capturedAt).toBe(new Date(0).toISOString());
  });

  it('serves a fresh snapshot from cache without re-probing', async () => {
    const { probe, calls } = fakeProbe([PANEL]);
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });

    svc.read();
    await settle();
    const first = svc.read();
    const second = svc.read();
    expect(second).toEqual(first);
    expect(calls()).toBe(1);
  });

  it('returns the stale snapshot immediately and refreshes in the background', async () => {
    const { probe, calls } = fakeProbe([PANEL, '10% used 100,000 / 1,000,000 AIC']);
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });

    svc.read();
    await settle();
    c.advance(2000); // expire the cache

    const stale = svc.read();
    expect(stale.status).toBe('ready');
    expect(stale.usage?.usedAic).toBe(25000); // old value returned right away
    await settle();
    expect(calls()).toBe(2);

    expect(svc.read().usage?.usedAic).toBe(100000);
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

    svc.read();
    await settle();
    c.advance(2000);
    const result = await svc.refresh();
    expect(result?.usedAic).toBe(25000); // previous snapshot kept
    // Data is still shown even though the newest capture failed.
    expect(svc.read().status).toBe('ready');
  });

  it('retains the cache when a later probe yields unparseable text', async () => {
    const { probe } = fakeProbe([PANEL, 'garbage with no credits']);
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });

    svc.read();
    await settle();
    const result = await svc.refresh();
    expect(result?.usedAic).toBe(25000);
  });

  it('reports why the first capture produced nothing instead of staying silent', async () => {
    const { probe } = fakeProbe([null]);
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });
    svc.read();
    await settle();
    const state = svc.read();
    expect(state.status).toBe('unavailable');
    expect(state.usage).toBeNull();
    expect(state.error).toMatch(/usage panel/);
  });

  it('reports unparseable first output as unavailable', async () => {
    const { probe } = fakeProbe(['nothing useful']);
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });
    svc.read();
    await settle();
    expect(svc.read().status).toBe('unavailable');
  });

  it('surfaces a thrown probe failure rather than crashing the read', async () => {
    const { probe } = fakeProbe([new Error('copilot is not installed')]);
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });
    svc.read();
    await settle();
    expect(svc.read()).toEqual({
      status: 'unavailable',
      usage: null,
      error: 'copilot is not installed',
    });
  });

  it('surfaces a non-Error probe rejection as text', async () => {
    const probe: PlanUsageProbe = { capture: () => Promise.reject('boom') };
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });
    svc.read();
    await settle();
    expect(svc.read().error).toBe('boom');
  });

  it('clears a previous failure once a capture succeeds', async () => {
    const { probe } = fakeProbe([null, PANEL]);
    const c = clock(0);
    const svc = createPlanUsageService({ probe, now: c.now, ttlMs: 1000 });
    svc.read();
    await settle();
    expect(svc.read().status).toBe('unavailable');
    await svc.refresh();
    expect(svc.read()).toMatchObject({ status: 'ready', error: null });
  });
});