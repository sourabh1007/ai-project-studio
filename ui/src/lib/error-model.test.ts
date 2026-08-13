import { describe, it, expect } from 'vitest';
import {
  classifyError,
  isRetryable,
  type AppErrorCategory,
} from './error-model.js';

/** Minimal ApiError-like shape (status + message + name). */
function apiError(status: number, message = ''): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.name = 'ApiError';
  err.status = status;
  return err;
}

describe('classifyError — HTTP statuses', () => {
  const cases: Array<[number, AppErrorCategory]> = [
    [401, 'auth'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [408, 'timeout'],
    [429, 'rate-limit'],
    [500, 'server'],
    [503, 'server'],
    [400, 'client'],
    [422, 'client'],
  ];

  for (const [status, category] of cases) {
    it(`maps HTTP ${status} to ${category}`, () => {
      const result = classifyError(apiError(status, 'boom'));
      expect(result.category).toBe(category);
      expect(result.status).toBe(status);
    });
  }

  it('classifies an out-of-range status as unknown', () => {
    const result = classifyError(apiError(302, 'redirect'));
    expect(result.category).toBe('unknown');
  });

  it('prefers a server-provided message for HTTP errors', () => {
    const result = classifyError(apiError(500, 'disk full'));
    expect(result.message).toBe('disk full');
    expect(result.detail).toBe('disk full');
  });

  it('falls back to friendly copy when an HTTP error has no message', () => {
    const result = classifyError(apiError(500, '   '));
    expect(result.message).toContain('unexpected error');
    expect(result.detail).toContain('unexpected error');
  });
});

describe('classifyError — non-HTTP errors', () => {
  it('classifies a rejected fetch TypeError as network', () => {
    const err = new TypeError('Failed to fetch');
    const result = classifyError(err);
    expect(result.category).toBe('network');
    expect(result.severity).toBe('error');
    expect(result.retryable).toBe(true);
  });

  it('classifies NetworkError message as network', () => {
    const result = classifyError(new Error('NetworkError when fetching'));
    expect(result.category).toBe('network');
  });

  it('classifies "network request failed" as network', () => {
    const result = classifyError(new Error('Network request failed'));
    expect(result.category).toBe('network');
  });

  it('classifies an AbortError as timeout', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyError(err).category).toBe('timeout');
  });

  it('classifies a message containing timeout as timeout', () => {
    expect(classifyError(new Error('Request timeout')).category).toBe('timeout');
  });

  it('classifies an unrecognized error as unknown', () => {
    const result = classifyError(new Error('weird failure'));
    expect(result.category).toBe('unknown');
    expect(result.message).toBe('An unexpected error occurred.');
    expect(result.detail).toBe('weird failure');
  });

  it('accepts a plain string as the message', () => {
    const result = classifyError('just a string');
    expect(result.category).toBe('unknown');
    expect(result.detail).toBe('just a string');
  });

  it('handles a non-object, non-string value', () => {
    const result = classifyError(42);
    expect(result.category).toBe('unknown');
    expect(result.detail).toBe('An unexpected error occurred.');
    expect(result.status).toBeNull();
  });

  it('ignores non-string name/message and non-number status fields', () => {
    const result = classifyError({ name: 1, message: 2, status: 'x' });
    expect(result.category).toBe('unknown');
    expect(result.status).toBeNull();
  });
});

describe('classifyError — offline precedence', () => {
  it('forces offline when the browser is offline, over any HTTP status', () => {
    const result = classifyError(apiError(500, 'server boom'), {
      browserOnline: false,
    });
    expect(result.category).toBe('offline');
    expect(result.severity).toBe('warning');
    expect(result.retryable).toBe(true);
  });

  it('does not force offline when browserOnline is true', () => {
    const result = classifyError(apiError(500), { browserOnline: true });
    expect(result.category).toBe('server');
  });
});

describe('isRetryable', () => {
  it('returns true for transient categories', () => {
    for (const c of [
      'offline',
      'network',
      'timeout',
      'rate-limit',
      'server',
    ] as AppErrorCategory[]) {
      expect(isRetryable(c)).toBe(true);
    }
  });

  it('returns false for terminal categories', () => {
    for (const c of [
      'auth',
      'forbidden',
      'not-found',
      'client',
      'unknown',
    ] as AppErrorCategory[]) {
      expect(isRetryable(c)).toBe(false);
    }
  });
});
