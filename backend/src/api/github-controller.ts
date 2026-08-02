import type { GithubAuthStatus } from '../github-auth/github-auth-service.js';
import type {
  DeviceCodeStart,
  DevicePollResult,
} from '../github-auth/github-device-auth.js';
import type { Route } from './http-contract.js';

export interface GithubControllerDeps {
  githubStatus: () => Promise<GithubAuthStatus>;
  /** Begins a device-flow sign-in and returns the code to show the user. */
  githubSignInStart: () => Promise<DeviceCodeStart>;
  /** Polls once for device-flow completion. */
  githubSignInPoll: (deviceCode: string) => Promise<DevicePollResult>;
  /** Logs the IDE's GitHub account out and returns the resulting status. */
  githubSignOut: () => Promise<GithubAuthStatus>;
}

/**
 * Routes for IDE-level GitHub authentication: the current status, plus the
 * two-step device-flow sign-in (`start` returns a one-time code + URL, `poll`
 * completes once the user authorizes in their browser).
 */
export function createGithubRoutes(deps: GithubControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/github/status',
      handler: async () => ({ status: 200, body: await deps.githubStatus() }),
    },
    {
      method: 'post',
      path: '/github/signin/start',
      handler: async () => ({
        status: 200,
        body: await deps.githubSignInStart(),
      }),
    },
    {
      method: 'post',
      path: '/github/signin/poll',
      handler: async (req) => {
        const body = (req.body ?? {}) as { deviceCode?: unknown };
        const deviceCode =
          typeof body.deviceCode === 'string' ? body.deviceCode : '';
        if (!deviceCode) {
          return {
            status: 400,
            body: {
              error: { kind: 'validation', message: 'deviceCode is required' },
            },
          };
        }
        return { status: 200, body: await deps.githubSignInPoll(deviceCode) };
      },
    },
    {
      method: 'post',
      path: '/github/signout',
      handler: async () => ({
        status: 200,
        body: await deps.githubSignOut(),
      }),
    },
  ];
}
