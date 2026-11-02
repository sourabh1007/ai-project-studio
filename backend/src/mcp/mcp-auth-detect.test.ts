import { describe, expect, it } from 'vitest';
import { classifyMcpAuth } from './mcp-auth-detect.js';

describe('classifyMcpAuth', () => {
  it('flags auth when the output mentions signing in', () => {
    const result = classifyMcpAuth('Please sign in to continue', []);
    expect(result.authRequired).toBe(true);
    expect(result.authUrl).toBeNull();
  });

  it('flags auth and extracts the first login URL from output', () => {
    const result = classifyMcpAuth('unauthorized', [
      'Run the following to authenticate:',
      'Open https://login.example.com/device?user_code=ABCD and enter the code',
    ]);
    expect(result.authRequired).toBe(true);
    expect(result.authUrl).toBe('https://login.example.com/device?user_code=ABCD');
  });

  it('detects a 401 status code as an auth need', () => {
    expect(classifyMcpAuth('request failed with 401', []).authRequired).toBe(
      true,
    );
  });

  it('does not flag ordinary crash output as an auth need', () => {
    const result = classifyMcpAuth(
      'MCP server exited before tool discovery completed',
      ['TypeError: cannot read property x of undefined'],
    );
    expect(result.authRequired).toBe(false);
    expect(result.authUrl).toBeNull();
  });

  it('returns no URL when auth is needed but none was printed', () => {
    const result = classifyMcpAuth('az login required', ['not logged in']);
    expect(result.authRequired).toBe(true);
    expect(result.authUrl).toBeNull();
  });

  it('classifies a null message using only the output lines', () => {
    const result = classifyMcpAuth(null, [
      'unauthorized',
      'Visit https://login.example.com/start to authenticate',
    ]);
    expect(result.authRequired).toBe(true);
    expect(result.authUrl).toBe('https://login.example.com/start');
  });

  it('extracts a login URL printed only in the message', () => {
    const result = classifyMcpAuth(
      'Please sign in at https://auth.example.com/login',
      ['no credentials found'],
    );
    expect(result.authRequired).toBe(true);
    expect(result.authUrl).toBe('https://auth.example.com/login');
  });

  it.each([
    '403 Forbidden', 'Permission denied', 'credential helper configured',
    'access token cache loaded', 'signed in successfully', 'Using login.example.com',
    'Listening on port 401', 'Connection refused', 'Timed out',
  ])('does not request reauthentication for unrelated diagnostics: %s', (message) => {
    expect(classifyMcpAuth(message, ['See https://example.test/documentation']))
      .toEqual({ authRequired: false, authUrl: null });
  });

  it.each([
    'http://login.example.test/device', 'https://user@login.example.test/device',
    'https://:password@login.example.test/device', 'https://login.example.test/device#private',
    'https://login.example.test/device?access_token=private',
    'https://login.example.test/device?client_secret=private',
    'https://login.example.test/device?code=private',
    'https://login.example.test/device?code_verifier=private', 'https://[',
  ])('withholds unsafe or credential-bearing sign-in URLs: %s', (url) => {
    expect(classifyMcpAuth('Authentication required', [url]))
      .toEqual({ authRequired: true, authUrl: null });
  });

  it('skips an unsafe URL and retains the next safe sign-in link', () => {
    expect(classifyMcpAuth('HTTP 401', [
      'Open http://unsafe.test or https://login.example.test/device?client_id=public&scope=read',
    ]).authUrl).toBe('https://login.example.test/device?client_id=public&scope=read');
  });
});
