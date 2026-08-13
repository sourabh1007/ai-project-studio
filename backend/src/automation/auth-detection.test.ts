import { describe, it, expect } from 'vitest';
import {
  AUTH_REQUIRED_MESSAGE,
  detectAuthFromError,
  detectAuthFromResult,
} from './auth-detection.js';
import type { CheckResult } from './automation-contract.js';

function result(overrides: Partial<CheckResult>): CheckResult {
  return {
    code: 200,
    status: '200',
    conclusion: null,
    text: 'ok',
    occurrenceKey: null,
    ...overrides,
  };
}

describe('detectAuthFromError', () => {
  it('flags auth phrases in an Error message', () => {
    expect(
      detectAuthFromError(new Error('Azure DevOps requires authentication')),
    ).toBe(AUTH_REQUIRED_MESSAGE);
  });

  it('flags a sign-in redirect URL in an Error message', () => {
    expect(
      detectAuthFromError(new Error('redirected to login.microsoftonline.com')),
    ).toBe(AUTH_REQUIRED_MESSAGE);
  });

  it('coerces a non-Error rejection to a string before matching', () => {
    expect(detectAuthFromError('401 unauthorized')).toBe(AUTH_REQUIRED_MESSAGE);
  });

  it('returns null for an unrelated error', () => {
    expect(detectAuthFromError(new Error('network timeout'))).toBeNull();
  });
});

describe('detectAuthFromResult', () => {
  it('flags an HTTP 401', () => {
    expect(detectAuthFromResult(result({ code: 401 }))).toBe(
      AUTH_REQUIRED_MESSAGE,
    );
  });

  it('flags an HTTP 403', () => {
    expect(detectAuthFromResult(result({ code: 403 }))).toBe(
      AUTH_REQUIRED_MESSAGE,
    );
  });

  it('flags a sign-in page body on an otherwise-OK response', () => {
    expect(
      detectAuthFromResult(
        result({ code: 200, text: 'Please sign in to your account' }),
      ),
    ).toBe(AUTH_REQUIRED_MESSAGE);
  });

  it('flags a _signin redirect URL in the body', () => {
    expect(
      detectAuthFromResult(result({ code: 200, text: 'go to /_signin?realm' })),
    ).toBe(AUTH_REQUIRED_MESSAGE);
  });

  it('returns null when the response is a normal success', () => {
    expect(detectAuthFromResult(result({ code: 200, text: 'completed' }))).toBeNull();
  });
});
