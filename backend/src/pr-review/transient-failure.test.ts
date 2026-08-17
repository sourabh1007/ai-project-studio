import { describe, expect, it } from 'vitest';
import { isTransientProviderFailure } from './transient-failure.js';

describe('isTransientProviderFailure', () => {
  it('treats upstream 5xx and GitHub auth blips as transient', () => {
    expect(
      isTransientProviderFailure(
        'Failed to fetch GitHub CLI user login (503): No server is currently available',
      ),
    ).toBe(true);
    expect(isTransientProviderFailure('Provider failed: 502 Bad Gateway')).toBe(true);
    expect(isTransientProviderFailure('HTTP 429 rate limit exceeded')).toBe(true);
  });

  it('treats network resets and a flaky CLI launch as transient', () => {
    expect(isTransientProviderFailure('read ECONNRESET')).toBe(true);
    expect(isTransientProviderFailure('getaddrinfo ENOTFOUND api.github.com')).toBe(true);
    expect(
      isTransientProviderFailure(
        'Error: Agent execution failed: launch_engine - copilot.exe exited with non-zero status',
      ),
    ).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isTransientProviderFailure('SERVICE UNAVAILABLE')).toBe(true);
  });

  it('never treats a runner timeout as transient', () => {
    expect(isTransientProviderFailure('Provider timed out after 120000ms')).toBe(false);
  });

  it('does not treat a genuine, non-infra failure as transient', () => {
    expect(isTransientProviderFailure('provider exited 1')).toBe(false);
    expect(isTransientProviderFailure('PR review step failed')).toBe(false);
    expect(isTransientProviderFailure('')).toBe(false);
  });
});
