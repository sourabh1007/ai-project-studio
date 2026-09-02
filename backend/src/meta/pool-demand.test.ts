import { describe, it, expect } from 'vitest';
import { PoolDemand, PoolDemandTracker } from './pool-demand.js';

function tracker(overrides: { now?: () => number; windowMs?: number; maxSize?: number } = {}) {
  let clock = overrides.now;
  return new PoolDemandTracker({
    now: clock ?? (() => 0),
    windowMs: overrides.windowMs ?? 1000,
    maxSize: overrides.maxSize ?? 100,
  });
}

describe('PoolDemandTracker', () => {
  it('suggests at least 1 with no observed demand', () => {
    expect(tracker().suggestion()).toBe(1);
  });

  it('tracks peak concurrency within the window', () => {
    let t = 0;
    const d = new PoolDemandTracker({ now: () => t, windowMs: 1000, maxSize: 100 });
    d.begin(); // 1
    d.begin(); // 2
    d.begin(); // 3 (peak)
    expect(d.inFlight).toBe(3);
    d.end();
    d.end();
    expect(d.inFlight).toBe(1);
    // Peak of 3 is still in the window.
    expect(d.suggestion()).toBe(3);
  });

  it('decays the suggestion once old samples fall outside the window', () => {
    let t = 0;
    const d = new PoolDemandTracker({ now: () => t, windowMs: 1000, maxSize: 100 });
    d.begin();
    d.begin(); // peak 2 at t=0
    d.end();
    d.end();
    t = 2000; // both samples now older than the 1000ms window
    // Nothing in flight and no in-window samples → back to the floor of 1.
    expect(d.suggestion()).toBe(1);
  });

  it('never suggests below the current in-flight count', () => {
    let t = 0;
    const d = new PoolDemandTracker({ now: () => t, windowMs: 1000, maxSize: 100 });
    d.begin();
    d.begin(); // in flight 2 at t=0
    t = 5000; // sample pruned, but two turns are still running
    expect(d.suggestion()).toBe(2);
  });

  it('clamps the suggestion to maxSize', () => {
    const d = new PoolDemandTracker({ now: () => 0, windowMs: 1000, maxSize: 2 });
    d.begin();
    d.begin();
    d.begin(); // peak 3
    expect(d.suggestion()).toBe(2);
  });

  it('ignores unbalanced end() calls', () => {
    const d = tracker();
    d.end();
    expect(d.inFlight).toBe(0);
  });
});

describe('PoolDemand', () => {
  it('creates one tracker per purpose lazily and reuses it', () => {
    let made = 0;
    const registry = new PoolDemand(() => {
      made += 1;
      return new PoolDemandTracker({ now: () => 0, windowMs: 1000, maxSize: 100 });
    });
    registry.begin('general');
    registry.begin('general');
    registry.begin('review');
    expect(made).toBe(2);
    expect(registry.suggestion('general')).toBe(2);
    expect(registry.suggestion('review')).toBe(1);
    registry.end('general');
    expect(registry.suggestion('general')).toBe(2);
  });
});
