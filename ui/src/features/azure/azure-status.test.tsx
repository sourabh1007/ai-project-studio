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
  it('shows the signed-in account and a sign-out button', async () => {
    window.localStorage.setItem('azureDevOpsOrg', 'contoso');
    const client = makeClient({
      getAzureStatus: vi
        .fn<() => Promise<AzureDevOpsStatus>>()
        .mockResolvedValue({ authenticated: true, account: 'alice', message: null }),
    });
    renderBadge(client);
    expect(await screen.findByText('Azure DevOps · contoso')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
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
