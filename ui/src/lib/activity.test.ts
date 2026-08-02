import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginActivity,
  clearActivityError,
  endActivity,
  failActivity,
  getActivitySnapshot,
  subscribeActivity,
} from './activity.js';

// Reset the module-level snapshot before each test by draining it.
beforeEach(() => {
  // End any lingering pending operations and clear errors.
  while (getActivitySnapshot().pending > 0) {
    endActivity();
  }
  clearActivityError();
});

describe('activity store', () => {
  it('tracks a begin/end cycle and notifies subscribers', () => {
    let notifications = 0;
    const unsubscribe = subscribeActivity(() => {
      notifications += 1;
    });

    beginActivity('Loading repos');
    expect(getActivitySnapshot()).toEqual({
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
});
