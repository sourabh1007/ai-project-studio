import { describe, expect, it, vi } from 'vitest';
import { createSessionAutoRetry } from './session-auto-retry.js';

/** Records resends/notices and captures the pending timer so tests can fire it. */
function harness(
  overrides: Partial<Parameters<typeof createSessionAutoRetry>[0]> = {},
) {
  const resends: string[] = [];
  const notices: string[] = [];
  let pending: (() => void) | null = null;
  const controller = createSessionAutoRetry({
    isTransient: (line) => line.includes('503'),
    maxAttempts: 2,
    backoffMs: 1000,
    resubmit: (prompt) => resends.push(prompt),
    notify: (text) => notices.push(text),
    setTimer: (fn) => {
      pending = fn;
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
      fn?.();
    },
    hasTimer: () => pending !== null,
  };
}

describe('createSessionAutoRetry', () => {
  it('re-submits the last typed prompt on a transient failure', () => {
    const h = harness();
    h.controller.observeInput('fix the bug\r');
    h.controller.observeOutput('Execution failed: 503 Service Unavailable\n');
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('attempt 1/2');
    h.fireTimer();
    expect(h.resends).toEqual(['fix the bug']);
  });

  it('reconstructs the prompt across chunked keystrokes and backspace', () => {
    const h = harness();
    for (const ch of 'helllo') {
      h.controller.observeInput(ch);
    }
    h.controller.observeInput('\x7f'); // erase the extra "o"
    h.controller.observeInput('\x08'); // erase the extra "l"
    h.controller.observeInput('\r');
    h.controller.observeOutput('boom 503\n');
    h.fireTimer();
    expect(h.resends).toEqual(['hell']);
  });

  it('ignores arrow-key and other escape sequences in the prompt', () => {
    const h = harness();
    h.controller.observeInput('ab\x1b[Dc\x1bOPd\r'); // CSI + SS3 sequences
    h.controller.observeOutput('fail 503\n');
    h.fireTimer();
    expect(h.resends).toEqual(['abcd']);
  });

  it('does not retry when no prompt has been submitted yet', () => {
    const h = harness();
    h.controller.observeOutput('503 right away\n');
    expect(h.hasTimer()).toBe(false);
    expect(h.notices).toHaveLength(0);
  });

  it('ignores blank submissions and whitespace-only input', () => {
    const h = harness();
    h.controller.observeInput('   \r');
    h.controller.observeOutput('503 here\n');
    expect(h.hasTimer()).toBe(false);
  });

  it('does not retry a non-transient failure', () => {
    const h = harness();
    h.controller.observeInput('do it\r');
    h.controller.observeOutput('Execution failed: 400 Bad Request\n');
    expect(h.hasTimer()).toBe(false);
    expect(h.resends).toHaveLength(0);
  });

  it('only scans complete output lines', () => {
    const h = harness();
    h.controller.observeInput('go\r');
    h.controller.observeOutput('partial 5'); // no newline yet
    expect(h.hasTimer()).toBe(false);
    h.controller.observeOutput('03 now\n');
    expect(h.hasTimer()).toBe(true);
  });

  it('caps retries per failure streak at maxAttempts', () => {
    const h = harness();
    h.controller.observeInput('retry me\r');
    h.controller.observeOutput('503 #1\n');
    h.fireTimer(); // attempt 1 resend
    h.controller.observeOutput('503 #2\n');
    h.fireTimer(); // attempt 2 resend
    h.controller.observeOutput('503 #3\n');
    expect(h.hasTimer()).toBe(false); // budget exhausted
    expect(h.resends).toEqual(['retry me', 'retry me']);
    expect(h.notices).toHaveLength(2);
  });

  it('does not schedule a second retry from a burst before the resend fires', () => {
    const h = harness();
    h.controller.observeInput('once\r');
    h.controller.observeOutput('503 a\n503 b\n');
    expect(h.notices).toHaveLength(1);
    h.fireTimer();
    expect(h.resends).toEqual(['once']);
  });

  it('resets the attempt budget when a new prompt is submitted', () => {
    const h = harness();
    h.controller.observeInput('first\r');
    h.controller.observeOutput('503\n');
    h.fireTimer();
    h.controller.observeOutput('503\n');
    h.fireTimer(); // exhausts budget for "first"
    h.controller.observeInput('second\r');
    h.controller.observeOutput('503\n');
    h.fireTimer();
    expect(h.resends).toEqual(['first', 'first', 'second']);
  });

  it('ignores control characters such as tab in the tracked prompt', () => {
    const h = harness();
    h.controller.observeInput('a\tb\x03\r'); // tab + Ctrl-C are dropped
    h.controller.observeOutput('boom 503\n');
    h.fireTimer();
    expect(h.resends).toEqual(['ab']);
  });

  it('ignores an escape followed by a non-CSI, non-SS3 character', () => {
    const h = harness();
    h.controller.observeInput('a\x1bzb\r'); // ESC + plain char are both dropped
    h.controller.observeOutput('boom 503\n');
    h.fireTimer();
    expect(h.resends).toEqual(['ab']);
  });

  it('does not require a notify callback', () => {
    const resends: string[] = [];
    let pending: (() => void) | null = null;
    const controller = createSessionAutoRetry({
      isTransient: (line) => line.includes('503'),
      maxAttempts: 1,
      backoffMs: 0,
      resubmit: (prompt) => resends.push(prompt),
      setTimer: (fn) => {
        pending = fn;
      },
    });
    controller.observeInput('x\r');
    controller.observeOutput('503\n');
    (pending as (() => void) | null)?.();
    expect(resends).toEqual(['x']);
  });

  it('bounds the pending output buffer between newlines', () => {
    const h = harness();
    h.controller.observeInput('go\r');
    h.controller.observeOutput('x'.repeat(20000)); // no newline: must be capped
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
      controller.observeInput('typed\r');
      controller.observeOutput('503\n');
      vi.advanceTimersByTime(5);
      expect(resends).toEqual(['typed']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('escalates once via onExhausted after the re-submit budget is spent', () => {
    const exhausted: Array<{ prompt: string; line: string }> = [];
    const h = harness({ onExhausted: (info) => exhausted.push(info) });
    h.controller.observeInput('heal me\r');
    h.controller.observeOutput('503 #1\n');
    h.fireTimer();
    h.controller.observeOutput('503 #2\n');
    h.fireTimer(); // budget now exhausted
    h.controller.observeOutput('503 #3\n'); // triggers escalation
    h.controller.observeOutput('503 #4\n'); // must not escalate again
    expect(exhausted).toEqual([{ prompt: 'heal me', line: '503 #3' }]);
  });

  it('escalates immediately when auto-retry is off (maxAttempts 0)', () => {
    const exhausted: Array<{ prompt: string; line: string }> = [];
    const h = harness({
      maxAttempts: 0,
      onExhausted: (info) => exhausted.push(info),
    });
    h.controller.observeInput('go\r');
    h.controller.observeOutput('503 straight away\n');
    expect(h.resends).toHaveLength(0);
    expect(exhausted).toEqual([
      { prompt: 'go', line: '503 straight away' },
    ]);
  });

  it('re-arms escalation for a fresh prompt after a prior streak escalated', () => {
    const exhausted: Array<{ prompt: string; line: string }> = [];
    const h = harness({
      maxAttempts: 0,
      onExhausted: (info) => exhausted.push(info),
    });
    h.controller.observeInput('first\r');
    h.controller.observeOutput('503 a\n');
    h.controller.observeInput('second\r');
    h.controller.observeOutput('503 b\n');
    expect(exhausted).toEqual([
      { prompt: 'first', line: '503 a' },
      { prompt: 'second', line: '503 b' },
    ]);
  });
});
