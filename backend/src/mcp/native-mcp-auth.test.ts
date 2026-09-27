import { describe, expect, it } from 'vitest';
import { nativeAuthenticationPrompt, nativeAuthenticationRequired, nativeToolInspection } from './native-mcp-auth.js';

describe('observed native authentication evidence', () => {
  it.each(['Authentication required', 'Unauthorized', 'To sign in', 'CredentialUnavailable', 'No credentials', 'Not logged in', 'Please login', 'To authenticate'])('recognizes an explicit challenge: %s', (message) => {
    expect(nativeAuthenticationRequired(message, [])).toBe(true);
  });
  it.each(['Timed out', 'Permission denied', '403 Forbidden', 'Connection refused', 'Process exited', 'credential cache loaded'])('does not infer authentication from: %s', (message) => {
    expect(nativeAuthenticationRequired(message, [])).toBe(false);
  });
  it('exposes only a recognized device challenge, without arbitrary query tokens or links', () => {
    expect(nativeAuthenticationPrompt(['To sign in, open https://microsoft.com/devicelogin and enter the code abcd12345']))
      .toEqual({ authUrl: 'https://microsoft.com/devicelogin', deviceCode: 'abcd12345' });
    expect(nativeAuthenticationPrompt(['Please sign in at https://www.microsoft.com/devicelogin']))
      .toEqual({ authUrl: 'https://microsoft.com/devicelogin', deviceCode: null });
    for (const text of [
      'https://microsoft.com/devicelogin',
      'Please sign in at http://microsoft.com/devicelogin',
      'Please sign in at https://microsoft.com.evil.test/devicelogin',
      'Please sign in at https://microsoft.com/devicelogin?access_token=secret',
      'Please sign in at https://example.test/secret',
    ]) expect(nativeAuthenticationPrompt([text])).toEqual({ authUrl: null, deviceCode: null });
  });
  it('never returns a finished probe URL/output or claims authorization from tools/list', () => {
    const base = { tools: [], message: null, output: ['Authentication required https://example.test/secret'], authUrl: 'https://example.test/secret' };
    const failed = nativeToolInspection({ ...base, status: 'failed' });
    expect(failed).toMatchObject({ authRequired: true, authUrl: null, output: [] });
    expect(failed.message).toContain('short probe has ended');
    const good = nativeToolInspection({ ...base, status: 'ok' });
    expect(good).toMatchObject({ authRequired: false, authUrl: null, output: [] });
    expect(good.message).toContain('has not been verified');
    const timeout = nativeToolInspection({ ...base, status: 'failed', message: 'Timed out', output: [] });
    expect(timeout.authRequired).toBe(false);
    expect(timeout.message).toContain('No authentication requirement was confirmed');
  });

  it('preserves a live Microsoft authorization-code URL and its callback state without inventing an endpoint', () => {
    const url = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?response_type=code&client_id=fixture&state=fixture-state&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback&code_challenge=fixture';
    expect(nativeAuthenticationPrompt([`To authenticate, open ${url}`])).toEqual({ authUrl: url, deviceCode: null });
    const older = url.replace('/v2.0', '').replace('localhost', '127.0.0.1');
    expect(nativeAuthenticationPrompt([`Please sign in: ${older}`])).toEqual({ authUrl: older, deviceCode: null });
  });

  it('rejects untrusted origins, leaked credentials, unusable callbacks and malformed native authorization URLs', () => {
    const base = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?response_type=code&client_id=fixture&state=fixture&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback';
    for (const url of [
      base.replace('login.microsoftonline.com', 'evil.test'),
      base.replace('https://', 'https://user@'),
      base.replace('https://', 'https://:password@'),
      base.replace('.com/', '.com:444/'),
      `${base}#access_token=private`,
      base.replace('/authorize?', '/other?'),
      `${base}&access_token=private`,
      `${base}&code=private`,
      base.replace('response_type=code', 'response_type=token'),
      base.replace('client_id=fixture&', ''),
      base.replace('state=fixture&', ''),
      base.replace(/&redirect_uri=.*/, ''),
      base.replace(/redirect_uri=.*/, 'redirect_uri=not-a-url'),
      base.replace(/redirect_uri=.*/, 'redirect_uri=ftp%3A%2F%2Flocalhost'),
      base.replace(/redirect_uri=.*/, 'redirect_uri=http%3A%2F%2Fuser%40localhost'),
      base.replace(/redirect_uri=.*/, 'redirect_uri=http%3A%2F%2F%3Apassword%40localhost'),
      base.replace(/redirect_uri=.*/, 'redirect_uri=http%3A%2F%2Flocalhost%23fragment'),
      base.replace('localhost', 'evil.test'),
      'https://[invalid',
      'https://',
    ]) expect(nativeAuthenticationPrompt([`Authentication required ${url}`])).toEqual({ authUrl: null, deviceCode: null });
  });
});
