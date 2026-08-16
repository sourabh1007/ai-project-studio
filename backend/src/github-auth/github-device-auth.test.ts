import { describe, it, expect, vi } from 'vitest';
import {
  createGithubDeviceAuth,
  describeDeviceError,
  GITHUB_CLIENT_ID,
  GITHUB_DEVICE_SCOPES,
  type DeviceHttpResponse,
} from './github-device-auth.js';

function httpStub(responses: DeviceHttpResponse[]) {
  const calls: { url: string; form: Record<string, string> }[] = [];
  let i = 0;
  const httpPost = (url: string, form: Record<string, string>) => {
    calls.push({ url, form });
    return Promise.resolve(responses[i++] ?? { status: 500, body: null });
  };
  return { httpPost, calls };
}

const startOk: DeviceHttpResponse = {
  status: 200,
  body: {
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    device_code: 'dev-code',
    interval: 7,
    expires_in: 600,
  },
};

describe('describeDeviceError', () => {
  it('maps known errors to actionable messages', () => {
    expect(describeDeviceError('expired_token')).toMatch(/expired/);
    expect(describeDeviceError('access_denied')).toMatch(/cancelled/);
    expect(describeDeviceError('incorrect_device_code')).toMatch(/rejected/);
    expect(describeDeviceError('incorrect_client_credentials')).toMatch(
      /rejected/,
    );
    expect(describeDeviceError('unsupported_grant_type')).toMatch(/rejected/);
  });

  it('echoes an unknown error and falls back when empty', () => {
    expect(describeDeviceError('boom')).toContain('boom');
    expect(describeDeviceError('')).toMatch(/failed/i);
  });
});

describe('createGithubDeviceAuth.start', () => {
  it('requests a device code with the default client id and scopes', async () => {
    const { httpPost, calls } = httpStub([startOk]);
    const auth = createGithubDeviceAuth({
      httpPost,
      ghLogin: () => Promise.resolve({ code: 0, stderr: '' }),
    });
    const start = await auth.start();
    expect(start).toEqual({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      deviceCode: 'dev-code',
      interval: 7,
      expiresIn: 600,
    });
    expect(calls[0].form).toEqual({
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_DEVICE_SCOPES,
    });
  });

  it('honours overridden client id and scopes and default interval/expiry', async () => {
    const { httpPost, calls } = httpStub([
      {
        status: 200,
        body: {
          user_code: 'X',
          verification_uri: 'https://gh/dev',
          device_code: 'd',
        },
      },
    ]);
    const auth = createGithubDeviceAuth({
      httpPost,
      ghLogin: () => Promise.resolve({ code: 0, stderr: '' }),
      clientId: 'my-id',
      scopes: 'repo',
    });
    const start = await auth.start();
    expect(start.interval).toBe(5);
    expect(start.expiresIn).toBe(900);
    expect(calls[0].form).toEqual({ client_id: 'my-id', scope: 'repo' });
  });

  it('throws GitHub error_description on a failed start', async () => {
    const { httpPost } = httpStub([
      { status: 422, body: { error_description: 'bad scope' } },
    ]);
    const auth = createGithubDeviceAuth({
      httpPost,
      ghLogin: () => Promise.resolve({ code: 0, stderr: '' }),
    });
    await expect(auth.start()).rejects.toThrow('bad scope');
  });

  it('throws a generic message when the body is not an object', async () => {
    const { httpPost } = httpStub([{ status: 500, body: null }]);
    const auth = createGithubDeviceAuth({
      httpPost,
      ghLogin: () => Promise.resolve({ code: 0, stderr: '' }),
    });
    await expect(auth.start()).rejects.toThrow(/Could not start/);
  });

  it('throws when required fields are missing even on a 200', async () => {
    const { httpPost } = httpStub([
      { status: 200, body: { user_code: 'X', verification_uri: 'u' } },
    ]);
    const auth = createGithubDeviceAuth({
      httpPost,
      ghLogin: () => Promise.resolve({ code: 0, stderr: '' }),
    });
    await expect(auth.start()).rejects.toThrow(/Could not start/);
  });
});

describe('createGithubDeviceAuth.poll', () => {
  it('stores the token via gh and reports success', async () => {
    const { httpPost } = httpStub([
      { status: 200, body: { access_token: 'gho_x' } },
    ]);
    const ghLogin = vi.fn(() => Promise.resolve({ code: 0, stderr: '' }));
    const auth = createGithubDeviceAuth({ httpPost, ghLogin });
    expect(await auth.poll('dev-code')).toEqual({ status: 'success' });
    expect(ghLogin).toHaveBeenCalledWith('gho_x');
  });

  it('reports an error when gh fails to store the token', async () => {
    const { httpPost } = httpStub([
      { status: 200, body: { access_token: 'gho_x' } },
    ]);
    const auth = createGithubDeviceAuth({
      httpPost,
      ghLogin: () => Promise.resolve({ code: 1, stderr: 'keyring locked' }),
    });
    expect(await auth.poll('dev-code')).toEqual({
      status: 'error',
      message: 'keyring locked',
    });
  });

  it('falls back to a default message when gh fails without stderr', async () => {
    const { httpPost } = httpStub([
      { status: 200, body: { access_token: 'gho_x' } },
    ]);
    const auth = createGithubDeviceAuth({
      httpPost,
      ghLogin: () => Promise.resolve({ code: 1, stderr: '' }),
    });
    const result = await auth.poll('dev-code');
    expect(result).toEqual({
      status: 'error',
      message: 'Signed in to GitHub, but saving the credential failed.',
    });
  });

  it('reports pending on authorization_pending, and a slow-down pending on slow_down', async () => {
    const { httpPost } = httpStub([
      { status: 200, body: { error: 'authorization_pending' } },
      { status: 200, body: { error: 'slow_down' } },
    ]);
    const auth = createGithubDeviceAuth({
      httpPost,
      ghLogin: () => Promise.resolve({ code: 0, stderr: '' }),
    });
    expect(await auth.poll('d')).toEqual({ status: 'pending' });
    expect(await auth.poll('d')).toEqual({ status: 'pending', slowDown: true });
  });

  it('reports a terminal error for other error codes', async () => {
    const { httpPost } = httpStub([
      { status: 200, body: { error: 'access_denied' } },
    ]);
    const auth = createGithubDeviceAuth({
      httpPost,
      ghLogin: () => Promise.resolve({ code: 0, stderr: '' }),
    });
    const result = await auth.poll('d');
    expect(result.status).toBe('error');
  });
});
