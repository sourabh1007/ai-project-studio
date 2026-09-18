import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { AzureDevOpsStatus } from '../../lib/types.js';
import { AzureStatusBadge } from './azure-status.js';

function makeClient(overrides: Partial<ApiClient>): ApiClient {
  return {
    getAzureStatus: vi
      .fn<() => Promise<AzureDevOpsStatus>>()
      .mockResolvedValue({ authenticated: false, account: null, message: null }),
    azureSignIn: vi
      .fn<() => Promise<AzureDevOpsStatus>>()
      .mockResolvedValue({ authenticated: true, account: 'alice', message: null }),
    azureSignOut: vi
      .fn<() => Promise<AzureDevOpsStatus>>()
      .mockResolvedValue({ authenticated: false, account: null, message: null }),
    listRepos: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ApiClient;
}

function renderBadge(client: ApiClient) {
  return render(
    <ApiProvider value={client}>
      <AzureStatusBadge />
    </ApiProvider>,
  );
}

afterEach(() => {
  window.localStorage.clear();
});

describe('AzureStatusBadge', () => {
  it('shows the signed-in username and a sign-out button', async () => {
    window.localStorage.setItem('azureDevOpsOrg', 'contoso');
    const client = makeClient({
      getAzureStatus: vi
        .fn<() => Promise<AzureDevOpsStatus>>()
        .mockResolvedValue({ authenticated: true, account: 'alice', message: null }),
    });
    renderBadge(client);
    expect(await screen.findByText('Azure DevOps · alice')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('falls back to the remembered username when a re-check omits it', async () => {
    window.localStorage.setItem('azureDevOpsOrg', 'contoso');
    window.localStorage.setItem('azureDevOpsAccount', 'alice');
    const client = makeClient({
      getAzureStatus: vi
        .fn<() => Promise<AzureDevOpsStatus>>()
        .mockResolvedValue({ authenticated: true, account: null, message: null }),
    });
    renderBadge(client);
    expect(await screen.findByText('Azure DevOps · alice')).toBeTruthy();
  });

  it('falls back to the org when no username is known', async () => {
    window.localStorage.setItem('azureDevOpsOrg', 'contoso');
    const client = makeClient({
      getAzureStatus: vi
        .fn<() => Promise<AzureDevOpsStatus>>()
        .mockResolvedValue({ authenticated: true, account: null, message: null }),
    });
    renderBadge(client);
    expect(await screen.findByText('Azure DevOps · contoso')).toBeTruthy();
  });

  it('signs out and re-checks status', async () => {
    window.localStorage.setItem('azureDevOpsOrg', 'contoso');
    const getAzureStatus = vi
      .fn<() => Promise<AzureDevOpsStatus>>()
      .mockResolvedValue({ authenticated: true, account: 'alice', message: null });
    const azureSignOut = vi
      .fn<() => Promise<AzureDevOpsStatus>>()
      .mockResolvedValue({ authenticated: false, account: null, message: null });
    const client = makeClient({ getAzureStatus, azureSignOut });
    renderBadge(client);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(azureSignOut).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(getAzureStatus.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it('surfaces a sign-out failure message', async () => {
    window.localStorage.setItem('azureDevOpsOrg', 'contoso');
    const client = makeClient({
      getAzureStatus: vi
        .fn<() => Promise<AzureDevOpsStatus>>()
        .mockResolvedValue({ authenticated: true, account: 'alice', message: null }),
      azureSignOut: vi.fn<() => Promise<AzureDevOpsStatus>>().mockResolvedValue({
        authenticated: false,
        account: null,
        message: 'Git Credential Manager is not installed.',
      }),
    });
    renderBadge(client);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByText('Git Credential Manager is not installed.'),
    ).toBeTruthy();
  });

  it('auto-detects the org from an Azure DevOps repo in the workspace', async () => {
    const remoteUrl = 'https://dev.azure.com/contoso/proj/_git/repo';
    const getAzureStatus = vi
      .fn<(org?: string) => Promise<AzureDevOpsStatus>>()
      .mockImplementation((org?: string) =>
        Promise.resolve(
          org
            ? { authenticated: true, account: 'alice', message: null }
            : { authenticated: false, account: null, message: null },
        ),
      );
    const client = makeClient({
      getAzureStatus,
      listRepos: vi.fn().mockResolvedValue([
        { id: 'r1', provider: 'github', remoteUrl: 'https://github.com/o/r' },
        { id: 'r2', provider: 'azure-devops', remoteUrl },
      ]),
    });
    renderBadge(client);
    expect(await screen.findByText('Azure DevOps · alice')).toBeTruthy();
    expect(getAzureStatus).toHaveBeenCalledWith(remoteUrl);
  });

  it('shows the org input and Sign in when signed out', async () => {
    const client = makeClient({
      getAzureStatus: vi
        .fn<() => Promise<AzureDevOpsStatus>>()
        .mockResolvedValue({ authenticated: false, account: null, message: null }),
    });
    renderBadge(client);
    expect(
      await screen.findByLabelText(
        'Azure DevOps organization or repository URL',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});
