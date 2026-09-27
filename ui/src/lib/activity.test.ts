import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  beginActivity,
  clearActivityError,
  endActivity,
  failActivity,
  getActivitySnapshot,
  subscribeActivity,
  activityDelay,
} from './activity.js';

// Reset the module-level snapshot before each test by draining it.
beforeEach(() => {
  // End any lingering pending operations and clear errors.
  while (getActivitySnapshot().pending > 0) {
    endActivity();
  }
  clearActivityError();
});
afterEach(() => vi.useRealTimers());

describe('activity store', () => {
  it('tracks a begin/end cycle and notifies subscribers', () => {
    let notifications = 0;
    const unsubscribe = subscribeActivity(() => {
      notifications += 1;
    });

    beginActivity('Loading repos');
    expect(getActivitySnapshot()).toMatchObject({
      pending: 1,
      label: 'Loading repos',
      error: null,
    });

    endActivity();
    expect(getActivitySnapshot()).toEqual({
      pending: 0,
      label: null,
      error: null,
    });

    expect(notifications).toBe(2);
    unsubscribe();
  });

  it('keeps the label while other operations are still pending', () => {
    beginActivity('first');
    beginActivity('second');
    endActivity();
    expect(getActivitySnapshot()).toMatchObject({
      pending: 1,
      label: 'second',
    });
  });

  it('records an error on failure and clears pending', () => {
    beginActivity('signing in');
    failActivity('no access');
    expect(getActivitySnapshot()).toEqual({
      pending: 0,
      label: null,
      error: 'no access',
    });
  });

  it('keeps the label on failure while other operations are still pending', () => {
    beginActivity('first');
    beginActivity('second');
    failActivity('partial failure');
    expect(getActivitySnapshot()).toMatchObject({
      pending: 1,
      label: 'second',
      error: 'partial failure',
    });
  });

  it('clears a recorded error', () => {
    beginActivity('x');
    failActivity('boom');
    clearActivityError();
    expect(getActivitySnapshot().error).toBeNull();
  });

  it('clearActivityError is a no-op when there is no error', () => {
    let notifications = 0;
    const unsubscribe = subscribeActivity(() => {
      notifications += 1;
    });
    clearActivityError();
    expect(notifications).toBe(0);
    unsubscribe();
  });

  it('does not drop below zero pending', () => {
    endActivity();
    expect(getActivitySnapshot().pending).toBe(0);
  });

  it('stops notifying after unsubscribe', () => {
    let notifications = 0;
    const unsubscribe = subscribeActivity(() => {
      notifications += 1;
    });
    unsubscribe();
    beginActivity('x');
    endActivity();
    expect(notifications).toBe(0);
  });

  it('a new begin clears a prior error', () => {
    failActivity('old error');
    beginActivity('retry');
    expect(getActivitySnapshot().error).toBeNull();
    endActivity();
  });

  it('tracks the oldest actual pending request across out-of-order completions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const first = beginActivity('slow read');
    vi.setSystemTime(2_000);
    const second = beginActivity('quick read');
    endActivity(second);
    expect(getActivitySnapshot()).toMatchObject({
      pending: 1, label: 'slow read', oldestStartedAt: 1_000,
    });
    expect(activityDelay(getActivitySnapshot(), 11_000)).toBe(10);
    endActivity(first);
    endActivity(first);
    expect(activityDelay(getActivitySnapshot(), 21_000)).toBeNull();
  });

  it('ends failed operations by identity and retains the newer start time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const first = beginActivity('old');
    vi.setSystemTime(2_000);
    const second = beginActivity('new');
    failActivity('failed', first);
    expect(getActivitySnapshot().oldestStartedAt).toBe(2_000);
    endActivity(second);
  });

  it('does not call fast, clock-shifted, or untimed activity delayed', () => {
    const activity = { pending: 1, label: 'read', error: null, oldestStartedAt: 1_000 };
    expect(activityDelay(activity, 10_999)).toBeNull();
    expect(activityDelay(activity, 500)).toBeNull();
    expect(activityDelay({ pending: 1, label: 'read', error: null }, 99_000)).toBeNull();
  });
});
