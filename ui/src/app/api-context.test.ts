import { describe, it, expect, beforeEach, vi } from 'vitest';
import { activityFetch, describeRequest, isAbortError } from './api-context.js';
import {
  clearActivityError,
  endActivity,
  getActivitySnapshot,
} from '../lib/activity.js';

beforeEach(() => {
  while (getActivitySnapshot().pending > 0) {
    endActivity();
  }
  clearActivityError();
  vi.restoreAllMocks();
});

describe('isAbortError', () => {
  it('recognizes a DOMException named AbortError', () => {
    expect(isAbortError(new DOMException('signal is aborted without reason', 'AbortError'))).toBe(true);
  });

  it('recognizes a plain Error named AbortError', () => {
    const err = new Error('signal is aborted without reason');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('rejects other errors', () => {
    expect(isAbortError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isAbortError('nope')).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

describe('activityFetch', () => {
  it('reports a successful request without an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    await activityFetch('/api/health');
    expect(getActivitySnapshot()).toEqual({ pending: 0, label: null, error: null });
  });

  it('records a friendly label as the error for a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    await activityFetch('/api/health');
    expect(getActivitySnapshot().error).toBe('Working…');
  });

  it('does not surface a cancelled request as a failure', async () => {
    const abortError = new DOMException('signal is aborted without reason', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));
    await expect(activityFetch('/api/meta/pools')).rejects.toBe(abortError);
    expect(getActivitySnapshot()).toEqual({ pending: 0, label: null, error: null });
  });

  it('surfaces a genuine network failure with its message', async () => {
    const networkError = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));
    await expect(activityFetch('/api/meta/pools')).rejects.toBe(networkError);
    expect(getActivitySnapshot().error).toBe('Failed to fetch');
  });
});

describe('describeRequest', () => {
  it('falls back to a generic label for an unmatched GET', () => {
    expect(describeRequest('GET', '/api/unknown')).toBe('Working…');
  });

  it('describes a PUT as saving', () => {
    expect(describeRequest('PUT', '/api/config/meta')).toBe('Saving…');
  });
});
