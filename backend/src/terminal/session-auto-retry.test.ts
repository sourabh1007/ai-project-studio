import { describe, expect, it, vi } from 'vitest';
import { createSessionAutoRetry } from './session-auto-retry.js';

/** Records resends/notices and captures the pending timer so tests can fire it. */
function harness(
  overrides: Partial<Parameters<typeof createSessionAutoRetry>[0]> = {},
) {
  const resends: string[] = [];
  const notices: string[] = [];
  let pending: (() => void) | null = null;
  let canceled = false;
  const controller = createSessionAutoRetry({
    isTransient: (line) => line.includes('503'),
    maxAttempts: 2,
    backoffMs: 1000,
    resubmit: (prompt) => resends.push(prompt),
    notify: (text) => notices.push(text),
    scheduleTimer: (fn) => {
      pending = fn;
      canceled = false;
      return () => {
        canceled = true;
        pending = null;
      };
    },
    ...overrides,
  });
  return {
    controller,
    resends,
    notices,
    fireTimer: () => {
      const fn = pending;
      pending = null;
      if (!canceled) {
        fn?.();
      }
    },
    hasTimer: () => pending !== null,
  };
}

describe('createSessionAutoRetry', () => {
  it('does not auto-retry plain raw input without provider confirmation', () => {
    const h = harness();
    h.controller.observeInput('fix the bug\r');
    h.controller.observeOutput('Execution failed: 503 Service Unavailable\n');
    expect(h.hasTimer()).toBe(false);
    expect(h.resends).toEqual([]);
    expect(h.notices).toEqual([
      expect.stringContaining('retry manually if needed'),
    ]);
  });

  it('does not let multiline bracketed paste establish replay authority', () => {
    const h = harness();
    h.controller.observeInput(
      '\x1b[200~first line\rsecond line\x1b[201~\r',
    );
    h.controller.observeOutput('Execution failed: 503 Service Unavailable\n');
    h.fireTimer();
    expect(h.resends).toEqual([]);
    expect(h.notices).toEqual([
      expect.stringContaining('provider confirms an exact replay-safe request'),
    ]);
  });

  it('does not let cursor/history/tab-completion keystrokes establish replay authority', () => {
    const h = harness();
    h.controller.observeInput('ab\x1b[A\x1b[Dc\t\r');
    h.controller.observeOutput('Execution failed: 503 Service Unavailable\n');
    expect(h.hasTimer()).toBe(false);
    expect(h.resends).toEqual([]);
  });

  it('shows manual guidance once per unconfirmed failure streak', () => {
    const h = harness();
    h.controller.observeOutput('503 a\n503 b\n');
    expect(h.notices).toHaveLength(1);
  });

  it('only scans complete output lines', () => {
    const h = harness();
    h.controller.confirmReplaySafeRequest('go');
    h.controller.observeOutput('partial 5');
    expect(h.hasTimer()).toBe(false);
    expect(h.notices).toHaveLength(0);
    h.controller.observeOutput('03 now\n');
    expect(h.hasTimer()).toBe(true);
  });

  it('retries a provider-confirmed safe request with exact text and whitespace preserved', () => {
    const h = harness();
    h.controller.confirmReplaySafeRequest('  keep exact whitespace  ');
    h.controller.observeOutput('503 #1\n');
    expect(h.notices[0]).toContain('attempt 1/2');
    h.fireTimer();
    expect(h.resends).toEqual(['  keep exact whitespace  ']);
  });

  it('caps retries per confirmed request at maxAttempts', () => {
    const h = harness();
    h.controller.confirmReplaySafeRequest('retry me');
    h.controller.observeOutput('503 #1\n');
    h.fireTimer();
    h.controller.observeOutput('503 #2\n');
    h.fireTimer();
    h.controller.observeOutput('503 #3\n');
    expect(h.hasTimer()).toBe(false);
    expect(h.resends).toEqual(['retry me', 'retry me']);
    expect(h.notices).toHaveLength(3);
  });

  it('does not schedule a second retry from a burst before the resend fires', () => {
    const h = harness();
    h.controller.confirmReplaySafeRequest('once');
    h.controller.observeOutput('503 a\n503 b\n');
    expect(h.notices).toHaveLength(1);
    h.fireTimer();
    expect(h.resends).toEqual(['once']);
  });

  it('clears prior authority when a new confirmed request arrives', () => {
    const h = harness();
    h.controller.confirmReplaySafeRequest('first');
    h.controller.observeOutput('503\n');
    h.controller.confirmReplaySafeRequest('second');
    expect(h.hasTimer()).toBe(false);
    h.controller.observeOutput('503\n');
    h.fireTimer();
    expect(h.resends).toEqual(['second']);
  });

  it('clears authority when confirmation is withdrawn with an empty exact text', () => {
    const h = harness();
    h.controller.confirmReplaySafeRequest('go');
    h.controller.confirmReplaySafeRequest('');
    h.controller.observeOutput('503\n');
    expect(h.resends).toEqual([]);
    expect(h.notices).toEqual([
      expect.stringContaining('retry manually if needed'),
    ]);
  });

  it('cancels a pending retry on Ctrl-C before the backoff elapses', () => {
    const h = harness();
    h.controller.confirmReplaySafeRequest('stay stopped');
    h.controller.observeOutput('503\n');
    expect(h.hasTimer()).toBe(true);
    h.controller.observeInput('\x03');
    expect(h.hasTimer()).toBe(false);
    h.fireTimer();
    expect(h.resends).toEqual([]);
  });

  it('ignores empty browser-input observations', () => {
    const h = harness();
    h.controller.confirmReplaySafeRequest('still valid');
    h.controller.observeOutput('503\n');
    h.controller.observeInput('');
    expect(h.hasTimer()).toBe(true);
    h.fireTimer();
    expect(h.resends).toEqual(['still valid']);
  });

  it('cancels a pending retry when new user input arrives before the backoff elapses', () => {
    const h = harness();
    h.controller.confirmReplaySafeRequest('old');
    h.controller.observeOutput('503\n');
    h.controller.observeInput('new');
    h.fireTimer();
    expect(h.resends).toEqual([]);
  });

  it('shows manual guidance when a confirmed request has no retry budget or escalation hook', () => {
    const h = harness({ maxAttempts: 0 });
    h.controller.confirmReplaySafeRequest('go');
    h.controller.observeOutput('503 straight away\n');
    expect(h.resends).toHaveLength(0);
    expect(h.notices).toEqual([
      expect.stringContaining('automatic retry budget was spent'),
    ]);
  });

  it('makes a stale timer callback inert even if the host cannot unschedule it', () => {
    let pending: (() => void) | null = null;
    const resends: string[] = [];
    const controller = createSessionAutoRetry({
      isTransient: (line) => line.includes('503'),
      maxAttempts: 1,
      backoffMs: 0,
      resubmit: (prompt) => resends.push(prompt),
      scheduleTimer: (fn) => {
        pending = fn;
        return () => {};
      },
    });
    controller.confirmReplaySafeRequest('old');
    controller.observeOutput('503\n');
    controller.observeInput('new');
    const fire: (() => void) | null = pending;
    if (fire !== null) {
      (fire as () => void)();
    }
    expect(resends).toEqual([]);
  });

  it('makes disposal leave an uncancellable pending retry callback inert', () => {
    let pending: (() => void) | null = null;
    const resends: string[] = [];
    const controller = createSessionAutoRetry({
      isTransient: (line) => line.includes('503'),
      maxAttempts: 1,
      backoffMs: 0,
      resubmit: (prompt) => resends.push(prompt),
      scheduleTimer: (fn) => {
        pending = fn;
        return () => {};
      },
    });
    controller.confirmReplaySafeRequest('old');
    controller.observeOutput('503\n');
    controller.dispose();
    const fire: (() => void) | null = pending;
    if (fire !== null) {
      (fire as () => void)();
    }
    expect(resends).toEqual([]);
  });

  it('escalates once via onExhausted after the confirmed retry budget is spent', () => {
    const exhausted: Array<{
      prompt: string;
      line: string;
      isCurrent: () => boolean;
    }> = [];
    const h = harness({ onExhausted: (info) => exhausted.push(info) });
    h.controller.confirmReplaySafeRequest('heal me');
    h.controller.observeOutput('503 #1\n');
    h.fireTimer();
    h.controller.observeOutput('503 #2\n');
    h.fireTimer();
    h.controller.observeOutput('503 #3\n');
    h.controller.observeOutput('503 #4\n');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].prompt).toBe('heal me');
    expect(exhausted[0].line).toBe('503 #3');
    expect(exhausted[0].isCurrent()).toBe(true);
    h.controller.observeInput('n');
    expect(exhausted[0].isCurrent()).toBe(false);
  });

  it('does not require a notify callback', () => {
    const resends: string[] = [];
    let pending: (() => void) | null = null;
    const controller = createSessionAutoRetry({
      isTransient: (line) => line.includes('503'),
      maxAttempts: 1,
      backoffMs: 0,
      resubmit: (prompt) => resends.push(prompt),
      scheduleTimer: (fn) => {
        pending = fn;
        return () => {
          pending = null;
        };
      },
    });
    controller.confirmReplaySafeRequest('x');
    controller.observeOutput('503\n');
    const fire: (() => void) | null = pending;
    if (fire !== null) {
      (fire as () => void)();
    }
    expect(resends).toEqual(['x']);
  });

  it('bounds the pending output buffer between newlines', () => {
    const h = harness();
    h.controller.confirmReplaySafeRequest('go');
    h.controller.observeOutput('x'.repeat(20000));
    h.controller.observeOutput('503 trailing\n');
    expect(h.hasTimer()).toBe(true);
  });

  it('defaults to a real timer when none is injected', () => {
    vi.useFakeTimers();
    try {
      const resends: string[] = [];
      const controller = createSessionAutoRetry({
        isTransient: (line) => line.includes('503'),
        maxAttempts: 1,
        backoffMs: 5,
        resubmit: (prompt) => resends.push(prompt),
      });
      controller.confirmReplaySafeRequest('typed');
      controller.observeOutput('503\n');
      vi.advanceTimersByTime(5);
      expect(resends).toEqual(['typed']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose cancels pending retry work and future output scanning', () => {
    const h = harness();
    h.controller.confirmReplaySafeRequest('typed');
    h.controller.observeOutput('503\n');
    expect(h.hasTimer()).toBe(true);
    h.controller.dispose();
    expect(h.hasTimer()).toBe(false);
    h.fireTimer();
    h.controller.observeOutput('503 again\n');
    expect(h.resends).toEqual([]);
    expect(h.notices).toHaveLength(1);
  });

  it('dispose invalidates previously issued exhaustion guards', () => {
    const exhausted: Array<{
      prompt: string;
      line: string;
      isCurrent: () => boolean;
    }> = [];
    const h = harness({ maxAttempts: 0, onExhausted: (info) => exhausted.push(info) });
    h.controller.confirmReplaySafeRequest('typed');
    h.controller.observeOutput('503\n');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].isCurrent()).toBe(true);
    h.controller.dispose();
    expect(exhausted[0].isCurrent()).toBe(false);
  });

  it('ignores later provider confirmations after disposal', () => {
    const h = harness();
    h.controller.dispose();
    h.controller.confirmReplaySafeRequest('typed');
    h.controller.observeOutput('503\n');
    h.fireTimer();
    expect(h.resends).toEqual([]);
    expect(h.notices).toEqual([]);
  });
});
