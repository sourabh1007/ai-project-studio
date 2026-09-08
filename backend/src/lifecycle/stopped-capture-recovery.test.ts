import { describe, expect, it, vi } from 'vitest';
import {
  createStoppedCaptureRecovery,
  type StoppedCaptureRecoveryDeps,
} from './stopped-capture-recovery.js';
import type { Session } from '../session/session-contract.js';
import type { UsageCapturePage } from '../usage/usage-capture-contract.js';

function session(id: string): Session {
  return {
    id,
    featureId: 'f1',
    name: null,
    provider: 'provider',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'completed',
    kind: 'dev',
    prompt: 'prompt',
    usageFilePath: 'usage.jsonl',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    exitCode: 0,
  };
}

describe('createStoppedCaptureRecovery', () => {
  it('drains stopped captures with bounded keyset pages and resets after the last page', () => {
    const pages = new Map<string | null, UsageCapturePage>([
      [null, {
        items: [{ sessionId: 's1', sourceId: 'src', cursor: '1', status: 'pending', reason: 'backfill' }],
        nextCursor: 's1',
      }],
      ['s1', {
        items: [{ sessionId: 's2', sourceId: 'src', cursor: '2', status: 'retrying', reason: 'source-finality-unknown' }],
        nextCursor: null,
      }],
    ]);
    const finalizations: string[] = [];
    const stops: string[] = [];
    const recovery = createStoppedCaptureRecovery({
      captures: {
        listUnfinishedPage: (afterSessionId, limit) => {
          expect(limit).toBe(2);
          return pages.get(afterSessionId) ?? { items: [], nextCursor: null };
        },
      },
      sessions: {
        get: (id) => session(id),
      },
      makeTailer: (s) => ({
        finalize: () => finalizations.push(s.id),
        stop: () => stops.push(s.id),
      }),
      hasLiveTailer: () => false,
      pageSize: 2,
      intervalMs: 1_000,
      logger: { error: vi.fn() },
    });

    recovery.finalize();
    recovery.finalize();
    recovery.finalize();

    expect(finalizations).toEqual(['s1', 's2', 's1']);
    expect(stops).toEqual(['s1', 's2', 's1']);
  });

  it('skips missing or live sessions and logs finalization failures while still stopping the tailer', () => {
    const error = vi.fn();
    const stop = vi.fn();
    const recovery = createStoppedCaptureRecovery({
      captures: {
        listUnfinishedPage: () => ({
          items: [
            { sessionId: 'live', sourceId: 'src', cursor: '1', status: 'pending', reason: 'backfill' },
            { sessionId: 'missing', sourceId: 'src', cursor: '2', status: 'pending', reason: 'backfill' },
            { sessionId: 'broken', sourceId: 'src', cursor: '3', status: 'pending', reason: 'backfill' },
          ],
          nextCursor: null,
        }),
      },
      sessions: {
        get: (id) => (id === 'missing' ? null : session(id)),
      },
      makeTailer: (s) => ({
        finalize: () => {
          if (s.id === 'broken') {
            throw new Error('fail');
          }
        },
        stop,
      }),
      hasLiveTailer: (sessionId) => sessionId === 'live',
      pageSize: 3,
      intervalMs: 1_000,
      logger: { error },
    });

    recovery.finalize();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('Recovered usage capture failed', expect.any(Error));
  });

  function fixture(overrides: Partial<StoppedCaptureRecoveryDeps> = {}) {
    const callbacks: (() => void)[] = [];
    const finalize = vi.fn();
    const cleanup = vi.fn();
    const page = vi.fn((after: string | null): UsageCapturePage => ({
      items: ['a', 'b'].filter((id) => after === null || id > after).map((sessionId) => ({
        sessionId, sourceId: 'src', cursor: null, status: 'pending', reason: null,
      })),
      nextCursor: null,
    }));
    const error = vi.fn();
    const clear = vi.fn();
    const schedule = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const deps: StoppedCaptureRecoveryDeps = {
      captures: { listUnfinishedPage: page },
      sessions: { get: session },
      makeTailer: () => ({ finalize, stop: cleanup }),
      hasLiveTailer: () => false,
      pageSize: 2, intervalMs: 100,
      logger: { error },
      scheduler: { setInterval: schedule, clearInterval: clear },
      ...overrides,
    };
    return { recovery: createStoppedCaptureRecovery(deps), deps, callbacks, finalize, cleanup, page, error, clear, schedule };
  }

  describe('recovery failure and generation ownership', () => {
    it.each(['session', 'live', 'factory', 'finalize', 'cleanup'] as const)(
      'contains a %s failure and keeps other entries and subsequent ticks progressing',
      (stage) => {
        const f = fixture();
        const failure = new Error(stage);
        if (stage === 'session') f.deps.sessions.get = vi.fn().mockImplementationOnce(() => { throw failure; }).mockImplementation(session);
        if (stage === 'live') f.deps.hasLiveTailer = vi.fn().mockImplementationOnce(() => { throw failure; }).mockReturnValue(false);
        if (stage === 'factory') f.deps.makeTailer = vi.fn().mockImplementationOnce(() => { throw failure; })
          .mockImplementation(() => ({ finalize: f.finalize, stop: f.cleanup }));
        if (stage === 'finalize') f.finalize.mockImplementationOnce(() => { throw failure; });
        if (stage === 'cleanup') f.cleanup.mockImplementationOnce(() => { throw failure; });
        expect(() => f.recovery.start()).not.toThrow();
        expect(f.error).toHaveBeenCalledWith(expect.any(String), failure);
        const attempts = f.finalize.mock.calls.length;
        expect(attempts).toBeGreaterThan(0);
        f.callbacks[0]();
        expect(f.finalize).toHaveBeenCalledTimes(attempts + 2);
        f.recovery.stop();
      },
    );

    it('contains page failure without losing the cursor or disabling future recovery', () => {
      const f = fixture();
      f.page.mockImplementationOnce(() => { throw new Error('locked'); });
      expect(() => f.recovery.start()).not.toThrow();
      expect(f.error).toHaveBeenCalledWith('Usage recovery page read failed', expect.any(Error));
      expect(f.finalize).not.toHaveBeenCalled();
      f.callbacks[0]();
      expect(f.page.mock.calls.map(([after]) => after)).toEqual([null, null]);
      expect(f.finalize).toHaveBeenCalledTimes(2);
      f.recovery.stop();
    });

    it.each(['page', 'session', 'factory', 'finalize'] as const)(
      'does not install a timer or continue the page when stopped during initial %s',
      (stage) => {
        const f = fixture();
        if (stage === 'page') f.page.mockImplementationOnce(() => {
          f.recovery.stop();
          return { items: [], nextCursor: null };
        });
        if (stage === 'session') f.deps.sessions.get = () => { f.recovery.stop(); return session('a'); };
        if (stage === 'factory') f.deps.makeTailer = () => {
          f.recovery.stop();
          return { finalize: f.finalize, stop: f.cleanup };
        };
        if (stage === 'finalize') f.finalize.mockImplementationOnce(() => { f.recovery.stop(); });
        f.recovery.start();
        expect(f.schedule).not.toHaveBeenCalled();
        expect(f.finalize).toHaveBeenCalledTimes(stage === 'finalize' ? 1 : 0);
        if (stage === 'factory' || stage === 'finalize') expect(f.cleanup).toHaveBeenCalledOnce();
      },
    );

    it('resumes after the last considered entry when stopped in the middle of a page', () => {
      const f = fixture();
      f.finalize.mockImplementationOnce(() => { f.recovery.stop(); });
      f.recovery.start();
      f.recovery.start();
      expect(f.page.mock.calls.map(([after]) => after)).toEqual([null, 'a']);
      expect(f.finalize).toHaveBeenCalledTimes(2);
      f.callbacks[0]();
      expect(f.finalize).toHaveBeenCalledTimes(4);
      f.recovery.stop();
    });

    it.each(['deleted', 'live'] as const)('rechecks session ownership after construction (%s)', (change) => {
      const f = fixture();
      f.deps.makeTailer = () => {
        if (change === 'deleted') f.deps.sessions.get = () => null;
        else f.deps.hasLiveTailer = () => true;
        return { finalize: f.finalize, stop: f.cleanup };
      };
      f.recovery.finalize();
      expect(f.finalize).not.toHaveBeenCalled();
      expect(f.cleanup).toHaveBeenCalledOnce();
    });

    it('ignores old interval callbacks after stop and restart', () => {
      const f = fixture();
      f.recovery.start();
      const stale = f.callbacks[0];
      f.recovery.stop();
      stale();
      expect(f.page).toHaveBeenCalledTimes(1);
      f.recovery.start();
      stale();
      expect(f.page).toHaveBeenCalledTimes(2);
      f.callbacks[1]();
      expect(f.page).toHaveBeenCalledTimes(3);
      f.recovery.stop();
      f.recovery.stop();
      expect(f.clear).toHaveBeenCalledTimes(2);
    });

    it.each(['session', 'live'] as const)('honors stop during the final %s ownership recheck', (stage) => {
      const f = fixture();
      if (stage === 'session') {
        f.deps.sessions.get = vi.fn().mockImplementationOnce(session).mockImplementation((id: string) => {
          f.recovery.stop();
          return session(id);
        });
      } else {
        f.deps.hasLiveTailer = vi.fn().mockReturnValueOnce(false).mockImplementation(() => {
          f.recovery.stop();
          return false;
        });
      }
      f.recovery.start();
      expect(f.finalize).not.toHaveBeenCalled();
      expect(f.cleanup).toHaveBeenCalledOnce();
      expect(f.schedule).not.toHaveBeenCalled();
    });

    it('does not overlap a page when stop/start reenters during finalization', () => {
      const f = fixture();
      f.finalize.mockImplementationOnce(() => {
        f.recovery.stop();
        f.recovery.start();
        f.recovery.finalize();
      });
      f.recovery.start();
      expect(f.schedule).toHaveBeenCalledTimes(1);
      expect(f.finalize).toHaveBeenCalledTimes(1);
      f.callbacks[0]();
      expect(f.finalize).toHaveBeenCalledTimes(2);
      f.recovery.stop();
    });

    it('clears a timer acquired after reentrant stop during scheduler registration', () => {
      const f = fixture();
      f.schedule.mockImplementationOnce((callback) => {
        f.callbacks.push(callback);
        f.recovery.stop();
        return 17;
      });
      f.recovery.start();
      expect(f.clear).toHaveBeenCalledWith(17);
      f.callbacks[0]();
      expect(f.page).toHaveBeenCalledTimes(1);
    });

    it('surfaces timer registration failure and permits a later start', () => {
      const f = fixture();
      f.schedule.mockImplementationOnce(() => { throw new Error('scheduler'); });
      expect(() => f.recovery.start()).toThrow('scheduler');
      f.recovery.start();
      expect(f.schedule).toHaveBeenCalledTimes(2);
      f.recovery.stop();
    });

    it('does not overwrite a newer start when an older scheduler registration fails', () => {
      const f = fixture();
      f.schedule.mockImplementationOnce(() => {
        f.recovery.stop();
        f.recovery.start();
        throw new Error('old scheduler');
      });
      expect(() => f.recovery.start()).toThrow('old scheduler');
      const count = f.page.mock.calls.length;
      f.callbacks[0]();
      expect(f.page).toHaveBeenCalledTimes(count + 1);
      f.recovery.stop();
      expect(f.clear).toHaveBeenCalledOnce();
    });

    it.each([NaN, 0, 1001])('rejects invalid page size %s', (pageSize) => {
      expect(() => fixture({ pageSize })).toThrow(RangeError);
    });

    it.each([NaN, 0, 2_147_483_648])('rejects invalid timer interval %s', (intervalMs) => {
      expect(() => fixture({ intervalMs })).toThrow(RangeError);
    });
  });

  it('starts immediately, does not install duplicate timers, and clears the interval on stop', () => {
    const setIntervalMock = vi.fn(() => Symbol('interval'));
    const clearIntervalMock = vi.fn();
    const listUnfinishedPage = vi.fn(() => ({ items: [], nextCursor: null }));
    const recovery = createStoppedCaptureRecovery({
      captures: { listUnfinishedPage },
      sessions: { get: () => null },
      makeTailer: () => ({ finalize: vi.fn(), stop: vi.fn() }),
      hasLiveTailer: () => false,
      pageSize: 1,
      intervalMs: 500,
      logger: { error: vi.fn() },
      scheduler: {
        setInterval: setIntervalMock,
        clearInterval: clearIntervalMock,
      },
    });

    recovery.start();
    recovery.start();
    recovery.stop();

    expect(listUnfinishedPage).toHaveBeenCalledTimes(1);
    expect(setIntervalMock).toHaveBeenCalledTimes(1);
    expect(clearIntervalMock).toHaveBeenCalledTimes(1);
  });

  it('ignores reentrant finalize calls while a page scan is already running', () => {
    let recovery: ReturnType<typeof createStoppedCaptureRecovery> | undefined;
    const listUnfinishedPage = vi.fn(() => {
      recovery?.finalize();
      return { items: [], nextCursor: null };
    });
    recovery = createStoppedCaptureRecovery({
      captures: { listUnfinishedPage },
      sessions: { get: () => null },
      makeTailer: () => ({ finalize: vi.fn(), stop: vi.fn() }),
      hasLiveTailer: () => false,
      pageSize: 1,
      intervalMs: 500,
      logger: { error: vi.fn() },
    });

    recovery.finalize();

    expect(listUnfinishedPage).toHaveBeenCalledTimes(1);
  });

  it('uses the default scheduler when none is injected', () => {
    vi.useFakeTimers();
    try {
      const listUnfinishedPage = vi.fn(() => ({ items: [], nextCursor: null }));
      const recovery = createStoppedCaptureRecovery({
        captures: { listUnfinishedPage },
        sessions: { get: () => null },
        makeTailer: () => ({ finalize: vi.fn(), stop: vi.fn() }),
        hasLiveTailer: () => false,
        pageSize: 1,
        intervalMs: 500,
        logger: { error: vi.fn() },
      });

      recovery.start();
      vi.advanceTimersByTime(500);
      recovery.stop();

      expect(listUnfinishedPage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
