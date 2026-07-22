import { describe, it, expect } from 'vitest';
import { ProcessLifecycle } from './process-lifecycle.js';
import { createClock } from '../../kernel/clock.js';

describe('process-lifecycle', () => {
  it('transitions starting -> running -> exited with timestamps', () => {
    let t = Date.parse('2026-07-21T00:00:00.000Z');
    const clock = createClock(() => (t += 1000));
    const lc = new ProcessLifecycle(clock);
    expect(lc.snapshot().phase).toBe('starting');

    lc.markRunning();
    let snap = lc.snapshot();
    expect(snap.phase).toBe('running');
    expect(snap.startedAt).toBe('2026-07-21T00:00:01.000Z');

    lc.markExited(0);
    snap = lc.snapshot();
    expect(snap.phase).toBe('exited');
    expect(snap.exitCode).toBe(0);
    expect(snap.endedAt).toBe('2026-07-21T00:00:02.000Z');
  });

  it('markRunning is ignored once past starting', () => {
    const clock = createClock(() => 0);
    const lc = new ProcessLifecycle(clock);
    lc.markExited(1);
    lc.markRunning();
    expect(lc.snapshot().phase).toBe('exited');
  });

  it('markExited is idempotent (first exit code wins)', () => {
    const clock = createClock(() => 0);
    const lc = new ProcessLifecycle(clock);
    lc.markRunning();
    lc.markExited(0);
    lc.markExited(2);
    expect(lc.snapshot().exitCode).toBe(0);
  });
});
