import { describe, it, expect, vi } from 'vitest';
import { createCliUsageTailer, type TailScheduler } from './cli-usage-tailer.js';
import type { UsageEvent } from './usage-contract.js';

function evt(turnIndex: number): UsageEvent {
  return {
    sessionId: 's1',
    featureId: 'f1',
    turnIndex,
    provider: 'agency',
    requestedModel: 'auto',
    resolvedModel: 'claude',
    operation: 'chat',
    inputTokens: 1,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    cost: 0,
    nanoAiu: 0,
    serviceRequestId: null,
    startedAt: 't',
    endedAt: 't',
  };
}

function controllableScheduler() {
  let tick: (() => void) | undefined;
  const clearInterval = vi.fn();
  const scheduler: TailScheduler = {
    setInterval: (callback) => {
      tick = callback;
      return 'handle';
    },
    clearInterval,
  };
  return { scheduler, clearInterval, fire: () => tick?.() };
}

describe('createCliUsageTailer', () => {
  it('emits initial events on start and only new ones on each poll', () => {
    const events = [evt(0)];
    const seen: number[] = [];
    const { scheduler, fire } = controllableScheduler();
    const tailer = createCliUsageTailer({
      read: () => [...events],
      onUsage: (e) => seen.push(e.turnIndex),
      intervalMs: 1000,
      scheduler,
    });

    tailer.start();
    expect(seen).toEqual([0]);

    events.push(evt(1), evt(2));
    fire();
    expect(seen).toEqual([0, 1, 2]);

    // No new rows: nothing emitted, cursor unchanged.
    fire();
    expect(seen).toEqual([0, 1, 2]);
  });

  it('drain performs a final flush of appended events', () => {
    const events = [evt(0)];
    const seen: number[] = [];
    const { scheduler } = controllableScheduler();
    const tailer = createCliUsageTailer({
      read: () => [...events],
      onUsage: (e) => seen.push(e.turnIndex),
      intervalMs: 1000,
      scheduler,
    });
    tailer.start();
    events.push(evt(1));
    tailer.drain();
    expect(seen).toEqual([0, 1]);
  });

  it('stop clears the scheduled interval', () => {
    const { scheduler, clearInterval } = controllableScheduler();
    const tailer = createCliUsageTailer({
      read: () => [],
      onUsage: () => {},
      intervalMs: 1000,
      scheduler,
    });
    tailer.start();
    tailer.stop();
    expect(clearInterval).toHaveBeenCalledWith('handle');
  });

  it('stop before start is a no-op', () => {
    const { scheduler, clearInterval } = controllableScheduler();
    const tailer = createCliUsageTailer({
      read: () => [],
      onUsage: () => {},
      intervalMs: 1000,
      scheduler,
    });
    tailer.stop();
    expect(clearInterval).not.toHaveBeenCalled();
  });

  it('uses Node timers when no scheduler is injected', () => {
    vi.useFakeTimers();
    try {
      const events = [evt(0)];
      const seen: number[] = [];
      const tailer = createCliUsageTailer({
        read: () => [...events],
        onUsage: (e) => seen.push(e.turnIndex),
        intervalMs: 100,
      });
      tailer.start();
      expect(seen).toEqual([0]);
      events.push(evt(1));
      vi.advanceTimersByTime(100);
      expect(seen).toEqual([0, 1]);
      tailer.stop();
      events.push(evt(2));
      vi.advanceTimersByTime(100);
      expect(seen).toEqual([0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
