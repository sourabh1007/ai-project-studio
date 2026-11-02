import { describe, expect, it } from 'vitest';
import { mcpObservationKey, observedMcpAuth } from './mcp-auth-observations.js';

describe('observed native auth state', () => {
  it('keys normalized configuration without retaining plaintext secrets and separates profiles', () => {
    const one = mcpObservationKey('agency', 'ado', { nested: { b: 2, a: [{ secret: 'private', other: null }] } });
    const two = mcpObservationKey('agency', 'ado', { nested: { a: [{ other: null, secret: 'private' }], b: 2 } });
    expect(one).toBe(two);
    expect(one).toMatch(/^[a-f0-9]{64}$/);
    expect(one).not.toContain('private');
    expect(one).not.toBe(mcpObservationKey('agency', 'ado', { nested: { b: 3 } }));
  });
  it('marks ready only after successful discovery and expiry only after explicit failure evidence', () => {
    const result = { tools: [], output: [], message: null };
    expect(observedMcpAuth({ ...result, status: 'ok' }, 'time').state).toBe('ready');
    expect(observedMcpAuth({ ...result, status: 'failed', message: 'Refresh token has expired' }, 'time')).toMatchObject({ state: 'expired', checkedAt: 'time' });
    expect(observedMcpAuth({ ...result, status: 'failed', output: ['Authentication required'] }, 'time').state).toBe('required');
    expect(observedMcpAuth({ ...result, status: 'failed', message: 'Timed out' }, 'time').state).toBe('unknown');
    expect(observedMcpAuth({ ...result, status: 'ok', output: ['expired credentials were refreshed'] }, 'time').state).toBe('ready');
  });
  it.each([false, true])('keeps interrupted native sign-in unknown even when tools/list succeeded (progress=%s)', (progress) => {
    const result = observedMcpAuth({
      status: 'ok', message: null, tools: [],
      output: progress ? [] : ['To sign in, open https://microsoft.com/devicelogin and enter the code ABCD12345'],
      authenticationInterrupted: progress,
    }, 'checked');
    expect(result).toMatchObject({ state: 'unknown', checkedAt: 'checked', interrupted: true });
    expect(result.message).toContain('credential caching could be confirmed');
    expect(JSON.stringify(result)).not.toContain('ABCD12345');
  });
});
