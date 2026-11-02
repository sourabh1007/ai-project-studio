import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { DeviceCodeStart, GithubStatus } from '../../lib/types.js';
import { GithubStatusBadge } from './github-status.js';

const startCode: DeviceCodeStart = {
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  deviceCode: 'dev-code-1',
  interval: 5,
  expiresIn: 900,
};

function makeClient(overrides: Partial<ApiClient>): ApiClient {
  return {
    getGithubStatus: vi
      .fn<() => Promise<GithubStatus>>()
      .mockResolvedValue({ authenticated: false } as GithubStatus),
    githubSignOut: vi.fn().mockResolvedValue({ authenticated: false }),
    githubSignInStart: vi.fn().mockResolvedValue(startCode),
    githubSignInPoll: vi.fn().mockResolvedValue({ status: 'pending' }),
    ...overrides,
  } as unknown as ApiClient;
}

function renderBadge(client: ApiClient) {
  return render(
    <ApiProvider value={client}>
      <GithubStatusBadge />
    </ApiProvider>,
  );
}

describe('GithubStatusBadge', () => {
  it('shows the signed-in login and a sign-out button', async () => {
    const client = makeClient({
      getGithubStatus: vi
        .fn<() => Promise<GithubStatus>>()
        .mockResolvedValue({ authenticated: true, login: 'octocat' } as GithubStatus),
    });
    renderBadge(client);
    expect(await screen.findByText('GitHub · octocat')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('signs out and re-checks status', async () => {
    const getGithubStatus = vi
      .fn<() => Promise<GithubStatus>>()
      .mockResolvedValue({ authenticated: true, login: 'octocat' } as GithubStatus);
    const githubSignOut = vi.fn().mockResolvedValue({ authenticated: false });
    const client = makeClient({ getGithubStatus, githubSignOut });
    renderBadge(client);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(githubSignOut).toHaveBeenCalledTimes(1));
    // Reload re-queries the status after signing out.
    await waitFor(() =>
      expect(getGithubStatus.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it('shows a sign-in prompt and opens the device-code modal', async () => {
    const client = makeClient({
      getGithubStatus: vi
        .fn<() => Promise<GithubStatus>>()
        .mockResolvedValue({ authenticated: false } as GithubStatus),
    });
    vi.spyOn(window, 'open').mockReturnValue(null);
    renderBadge(client);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByRole('heading', { name: 'Sign in to GitHub' }),
    ).toBeTruthy();
    expect(client.githubSignInStart).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('preserves the signed-in account during an unavailable check instead of requesting sign-in again', async () => {
    const getGithubStatus = vi.fn<() => Promise<GithubStatus>>()
      .mockResolvedValueOnce({ authenticated: true, login: 'octocat' })
      .mockRejectedValueOnce(new Error('Stored credentials could not be checked.'));
    const client = makeClient({ getGithubStatus });
    renderBadge(client);
    const recheck = await screen.findByRole('button', { name: /GitHub · octocat/ });
    await waitFor(() => expect(recheck).toBeEnabled());
    fireEvent.click(recheck);
    expect(await screen.findByRole('alert')).toHaveTextContent('Stored credentials could not be checked.');
    expect(screen.getByText('GitHub · octocat')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(client.githubSignInStart).not.toHaveBeenCalled();
  });

  it('retries an unknown account check without starting an unnecessary device flow', async () => {
    const getGithubStatus = vi.fn<() => Promise<GithubStatus>>()
      .mockRejectedValueOnce(new Error('Keyring unavailable.'))
      .mockResolvedValueOnce({ authenticated: true, login: 'octocat' });
    const client = makeClient({ getGithubStatus });
    renderBadge(client);
    const retry = await screen.findByRole('button', { name: 'GitHub · status unavailable' });
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByText('GitHub · octocat')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(client.githubSignInStart).not.toHaveBeenCalled();
  });

  it.each([true, false])('surfaces an incomplete sign-out without an unhandled rejection (rejected: %s)', async (rejected) => {
    const githubSignOut = rejected
      ? vi.fn().mockRejectedValue(new Error('Sign-out unavailable.'))
      : vi.fn().mockResolvedValue({ authenticated: true, login: 'octocat' });
    const client = makeClient({
      getGithubStatus: vi.fn().mockResolvedValue({ authenticated: true, login: 'octocat' }),
      githubSignOut,
    });
    renderBadge(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(rejected ? 'Sign-out unavailable.' : 'sign-out did not complete');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled());
  });
});
