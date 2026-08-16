/**
 * In-app GitHub sign-in via the OAuth **device flow**, so a user who has never
 * run `gh auth login` can authenticate without leaving the IDE. `start()` asks
 * GitHub for a one-time user code + verification URL (shown in the UI); the user
 * enters the code in their browser; `poll()` is then called repeatedly until
 * GitHub returns an access token, which is handed to `gh auth login --with-token`
 * so the rest of the app (which reads `gh auth status` / `gh auth token`) picks
 * the login up transparently and refreshes it going forward.
 *
 * All I/O is injected so this module stays pure and unit-tested; the real HTTP
 * client and `gh` runner are wired in main.ts.
 */

/** The GitHub CLI's public OAuth app client id — it has the device flow enabled. */
export const GITHUB_CLIENT_ID = '178c6fc778ccc68e1d6a';
/** Scopes `gh` itself requests, so the minted token works for every gh command. */
export const GITHUB_DEVICE_SCOPES = 'repo read:org gist workflow';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export interface DeviceHttpResponse {
  status: number;
  body: unknown;
}

/** Posts a form-encoded body and returns the JSON response GitHub sends back. */
export type DeviceHttpPost = (
  url: string,
  form: Record<string, string>,
) => Promise<DeviceHttpResponse>;

/** Stores a freshly minted token via `gh auth login --with-token`. */
export type GhLoginRunner = (
  token: string,
) => Promise<{ code: number; stderr: string }>;

/** The one-time code the user enters in their browser to authorize sign-in. */
export interface DeviceCodeStart {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  /** Minimum seconds to wait between polls (GitHub-supplied). */
  interval: number;
  /** Seconds until the device code expires. */
  expiresIn: number;
}

export type DevicePollResult =
  | { status: 'pending'; slowDown?: boolean }
  | { status: 'success' }
  | { status: 'error'; message: string };

export interface GithubDeviceAuth {
  /** Begins a device-flow sign-in and returns the code to show the user. */
  start(): Promise<DeviceCodeStart>;
  /** Polls once for completion; call repeatedly while it returns `pending`. */
  poll(deviceCode: string): Promise<DevicePollResult>;
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object'
    ? (body as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Maps a device-flow error code to a message a user can act on. */
export function describeDeviceError(error: string): string {
  switch (error) {
    case 'expired_token':
      return 'The sign-in code expired before you finished. Please start again.';
    case 'access_denied':
      return 'Sign-in was cancelled.';
    case 'incorrect_device_code':
    case 'incorrect_client_credentials':
    case 'unsupported_grant_type':
      return 'GitHub rejected the sign-in request. Please start again.';
    default:
      return error
        ? `GitHub sign-in failed: ${error}`
        : 'GitHub sign-in failed. Please start again.';
  }
}

/** Builds the GitHub device-flow auth facade from injected I/O. */
export function createGithubDeviceAuth(deps: {
  httpPost: DeviceHttpPost;
  ghLogin: GhLoginRunner;
  clientId?: string;
  scopes?: string;
}): GithubDeviceAuth {
  const clientId = deps.clientId ?? GITHUB_CLIENT_ID;
  const scopes = deps.scopes ?? GITHUB_DEVICE_SCOPES;

  return {
    async start() {
      const res = await deps.httpPost(DEVICE_CODE_URL, {
        client_id: clientId,
        scope: scopes,
      });
      const body = asRecord(res.body);
      const userCode = str(body.user_code);
      const verificationUri = str(body.verification_uri);
      const deviceCode = str(body.device_code);
      if (res.status !== 200 || !userCode || !verificationUri || !deviceCode) {
        throw new Error(
          str(body.error_description) ||
            'Could not start GitHub sign-in. Check your network connection and try again.',
        );
      }
      return {
        userCode,
        verificationUri,
        deviceCode,
        interval: typeof body.interval === 'number' ? body.interval : 5,
        expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 900,
      };
    },

    async poll(deviceCode) {
      const res = await deps.httpPost(ACCESS_TOKEN_URL, {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: GRANT_TYPE,
      });
      const body = asRecord(res.body);
      const token = str(body.access_token);
      if (token) {
        const login = await deps.ghLogin(token);
        if (login.code !== 0) {
          return {
            status: 'error',
            message:
              login.stderr.trim() ||
              'Signed in to GitHub, but saving the credential failed.',
          };
        }
        return { status: 'success' };
      }
      const error = str(body.error);
      if (error === 'authorization_pending') {
        return { status: 'pending' };
      }
      // GitHub asks us to poll less often; the caller must add >=5s to its
      // interval, otherwise it keeps getting `slow_down` and never completes.
      if (error === 'slow_down') {
        return { status: 'pending', slowDown: true };
      }
      return { status: 'error', message: describeDeviceError(error) };
    },
  };
}
