import { describe, it, expect } from 'vitest';
import { buildGithubCredentialEnv } from './github-credential-env.js';

describe('buildGithubCredentialEnv', () => {
  it('returns an empty object when there is no token', () => {
    expect(buildGithubCredentialEnv(null)).toEqual({});
    expect(buildGithubCredentialEnv('')).toEqual({});
  });

  it('exposes the token as GITHUB_TOKEN and GH_TOKEN', () => {
    const env = buildGithubCredentialEnv('gho_abc123');
    expect(env.GITHUB_TOKEN).toBe('gho_abc123');
    expect(env.GH_TOKEN).toBe('gho_abc123');
  });

  it('disables interactive prompts and installs an inline github.com helper', () => {
    const env = buildGithubCredentialEnv('gho_abc123');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_1).toContain('password=${GITHUB_TOKEN}');
  });
});
