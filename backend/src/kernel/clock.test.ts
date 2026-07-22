import { describe, it, expect } from 'vitest';
import { createClock } from './clock.js';

describe('clock', () => {
  it('uses injected source for now() and isoNow()', () => {
    const fixed = Date.parse('2026-07-21T00:00:00.000Z');
    const clock = createClock(() => fixed);
    expect(clock.now().getTime()).toBe(fixed);
    expect(clock.isoNow()).toBe('2026-07-21T00:00:00.000Z');
  });

  it('defaults to Date.now', () => {
    const clock = createClock();
    const before = Date.now();
    const t = clock.now().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
  });
});
