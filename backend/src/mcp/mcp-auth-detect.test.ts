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
      'Open https://login.example.com/device?code=ABCD and enter the code',
    ]);
    expect(result.authRequired).toBe(true);
    expect(result.authUrl).toBe('https://login.example.com/device?code=ABCD');
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
});
