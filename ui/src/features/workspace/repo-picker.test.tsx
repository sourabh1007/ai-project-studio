import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { ApiError, type ApiClient } from '../../lib/api.js';
import type { Repository } from '../../lib/types.js';
import { RepoPicker } from './repo-picker.js';

afterEach(() => {
  delete (globalThis as { desktop?: unknown }).desktop;
  window.localStorage.clear();
});

describe('RepoPicker context add flow', () => {
  it('lists only signed-in organizations and loads/searches their project/repository names on selection', async () => {
    window.localStorage.setItem('azureDevOpsConnections', JSON.stringify(['contoso', 'fabrikam', 'signed-out']));
    const listAzureRepos = vi.fn(async (org: string) => org === 'contoso' ? [
      { provider: 'azure-devops', name: 'Billing/payments', remoteUrl: 'https://dev.azure.com/contoso/Billing/_git/payments' },
      { provider: 'azure-devops', name: 'Billing/reconcile', remoteUrl: 'https://dev.azure.com/contoso/Billing/_git/reconcile' },
      { provider: 'azure-devops', name: 'Platform/kernel', remoteUrl: 'https://dev.azure.com/contoso/Platform/_git/kernel' },
    ] : [{ provider: 'azure-devops', name: 'Inventory/catalog', remoteUrl: 'https://dev.azure.com/fabrikam/Inventory/_git/catalog' }]);
    const client = {
      listGithubRepos: vi.fn().mockResolvedValue([]), listAzureRepos,
      getAzureStatus: vi.fn(async (org: string) => ({ authenticated: org !== 'signed-out', account: 'same-account' })),
      azureSignIn: vi.fn(),
    } as unknown as ApiClient;
    render(<ApiProvider value={client}><RepoPicker onClose={() => {}} onAdded={() => {}} /></ApiProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Azure DevOps' }));
    const selector = screen.getByRole('combobox', { name: 'Signed-in organization' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh organizations' })).toBeEnabled());
    expect(within(selector).getAllByRole('option').map((option) => option.textContent)).toEqual(['Select an organization', 'contoso', 'fabrikam']);
    fireEvent.change(selector, { target: { value: 'contoso' } });
    await screen.findByRole('button', { name: 'Billing/payments' });
    expect(listAzureRepos).toHaveBeenLastCalledWith('contoso');
    const search = screen.getByRole('searchbox', { name: 'Search repositories' });
    expect(search).toHaveAttribute('placeholder', 'Search project or repository names');
    fireEvent.change(search, { target: { value: 'BILLING' } });
    expect(screen.getByRole('button', { name: 'Billing/reconcile' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Platform/kernel' })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'kernel' } });
    expect(screen.getByRole('button', { name: 'Platform/kernel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Billing/payments' })).not.toBeInTheDocument();
    fireEvent.change(selector, { target: { value: 'fabrikam' } });
    await screen.findByRole('button', { name: 'Inventory/catalog' });
    expect(screen.getByRole('searchbox', { name: 'Search repositories' })).toHaveValue('');
    expect(listAzureRepos).toHaveBeenLastCalledWith('fabrikam');
    expect(screen.queryByRole('button', { name: 'Platform/kernel' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('azureDevOpsOrg')).toBe('fabrikam');
    expect(client.azureSignIn).not.toHaveBeenCalled();
  });
  it('ignores a previous organization response after the user switches organizations', async () => {
    window.localStorage.setItem('azureDevOpsConnections', JSON.stringify(['contoso', 'fabrikam']));
    let finish!: (value: unknown[]) => void;
    const listAzureRepos = vi.fn((org: string) => org === 'contoso' ? new Promise<unknown[]>((resolve) => { finish = resolve; })
      : Promise.resolve([{ provider: 'azure-devops', name: 'Inventory/current', remoteUrl: 'https://dev.azure.com/fabrikam/Inventory/_git/current' }]));
    const client = {
      listGithubRepos: vi.fn().mockResolvedValue([]), listAzureRepos,
      getAzureStatus: vi.fn().mockResolvedValue({ authenticated: true }),
    } as unknown as ApiClient;
    render(<ApiProvider value={client}><RepoPicker onClose={() => {}} onAdded={() => {}} /></ApiProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Azure DevOps' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh organizations' })).toBeEnabled());
    const selector = screen.getByRole('combobox', { name: 'Signed-in organization' });
    fireEvent.change(selector, { target: { value: 'contoso' } });
    await waitFor(() => expect(listAzureRepos).toHaveBeenCalledWith('contoso'));
    fireEvent.change(selector, { target: { value: 'fabrikam' } });
    await screen.findByRole('button', { name: 'Inventory/current' });
    await act(async () => finish([{ provider: 'azure-devops', name: 'Billing/stale', remoteUrl: 'https://dev.azure.com/contoso/Billing/_git/stale' }]));
    expect(screen.getByRole('button', { name: 'Inventory/current' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Billing/stale' })).not.toBeInTheDocument();
  });
  it('retains a last-confirmed signed-in organization on unavailable checks, without forcing a sign-in', async () => {
    window.localStorage.setItem('azureDevOpsConnections', '["contoso"]');
    const client = {
      listGithubRepos: vi.fn().mockResolvedValue([]), listAzureRepos: vi.fn().mockResolvedValue([]),
      getAzureStatus: vi.fn().mockResolvedValueOnce({ authenticated: true }).mockRejectedValue(new Error('Credential helper busy')),
      azureSignIn: vi.fn(),
    } as unknown as ApiClient;
    render(<ApiProvider value={client}><RepoPicker onClose={() => {}} onAdded={() => {}} /></ApiProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Azure DevOps' }));
    await screen.findByRole('option', { name: 'contoso' });
    const refresh = screen.getByRole('button', { name: 'Refresh organizations' });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);
    await screen.findByText('Some organization checks are unavailable. Retry to refresh the signed-in list.');
    expect(screen.getByRole('option', { name: 'contoso' })).toBeInTheDocument();
    expect(client.azureSignIn).not.toHaveBeenCalled();
  });
  it('closes after the fast add response without waiting for context generation', async () => {
    const added: Repository = {
      id: 'r1',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/app',
      name: 'acme/app',
      localPath: 'C:\\repos\\app',
      defaultBranch: 'main',
      createdAt: '2025-01-01T00:00:00Z',
    };
    const addRepo = vi.fn().mockResolvedValue(added);
    const client = {
      listGithubRepos: vi.fn().mockResolvedValue([
        {
          provider: 'github',
          name: 'acme/app',
          remoteUrl: added.remoteUrl,
          defaultBranch: 'main',
        },
      ]),
      addRepo,
    } as unknown as ApiClient;
    const onAdded = vi.fn();
    render(
      <ApiProvider value={client}>
        <RepoPicker onClose={() => {}} onAdded={onAdded} />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /acme\/app/i }));
    fireEvent.change(screen.getByLabelText('New folder path'), {
      target: { value: 'C:\\repos\\app' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clone & add' }));

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(added));
    expect(addRepo).toHaveBeenCalledTimes(1);
  });

  it('browses for a clone parent folder and appends the repo leaf name', async () => {
    const chooseDirectory = vi.fn().mockResolvedValue('C:\\repos');
    (globalThis as { desktop?: unknown }).desktop = { chooseDirectory };
    const client = {
      listGithubRepos: vi.fn().mockResolvedValue([
        { provider: 'github', name: 'acme/app', remoteUrl: 'https://github.com/acme/app' },
      ]),
      addRepo: vi.fn(),
    } as unknown as ApiClient;
    render(
      <ApiProvider value={client}>
        <RepoPicker onClose={() => {}} onAdded={() => {}} />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /acme\/app/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));

    await waitFor(() =>
      expect(
        (screen.getByLabelText('New folder path') as HTMLInputElement).value,
      ).toBe('C:\\repos\\app'),
    );
    expect(chooseDirectory).toHaveBeenCalledTimes(1);
  });

  it('browses for an existing checkout folder and uses it as-is', async () => {
    const chooseDirectory = vi.fn().mockResolvedValue('D:\\work\\app');
    (globalThis as { desktop?: unknown }).desktop = { chooseDirectory };
    const client = {
      listGithubRepos: vi.fn().mockResolvedValue([
        { provider: 'github', name: 'acme/app', remoteUrl: 'https://github.com/acme/app' },
      ]),
      addRepo: vi.fn(),
    } as unknown as ApiClient;
    render(
      <ApiProvider value={client}>
        <RepoPicker onClose={() => {}} onAdded={() => {}} />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /acme\/app/i }));
    fireEvent.click(screen.getByRole('radio', { name: /use existing checkout/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));

    await waitFor(() =>
      expect(
        (screen.getByLabelText('Existing checkout path') as HTMLInputElement).value,
      ).toBe('D:\\work\\app'),
    );
  });

  it('hides the browse button when no desktop shell is present', async () => {
    const client = {
      listGithubRepos: vi.fn().mockResolvedValue([
        { provider: 'github', name: 'acme/app', remoteUrl: 'https://github.com/acme/app' },
      ]),
      addRepo: vi.fn(),
    } as unknown as ApiClient;
    render(
      <ApiProvider value={client}>
        <RepoPicker onClose={() => {}} onAdded={() => {}} />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /acme\/app/i }));
    expect(screen.queryByRole('button', { name: 'Browse…' })).toBeNull();
  });

  it('filters the repository list by the search box', async () => {
    const client = {
      listGithubRepos: vi.fn().mockResolvedValue([
        { provider: 'github', name: 'acme/app', remoteUrl: 'https://github.com/acme/app' },
        { provider: 'github', name: 'acme/tools', remoteUrl: 'https://github.com/acme/tools' },
      ]),
      addRepo: vi.fn(),
    } as unknown as ApiClient;
    render(
      <ApiProvider value={client}>
        <RepoPicker onClose={() => {}} onAdded={() => {}} />
      </ApiProvider>,
    );

    await screen.findByRole('button', { name: /acme\/app/i });
    expect(screen.getByRole('button', { name: /acme\/tools/i })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search repositories'), {
      target: { value: 'tools' },
    });

    expect(screen.queryByRole('button', { name: /acme\/app/i })).toBeNull();
    expect(screen.getByRole('button', { name: /acme\/tools/i })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search repositories'), {
      target: { value: 'nomatch' },
    });
    expect(screen.getByText('No repositories match your search.')).toBeTruthy();
  });

  it('loads Azure DevOps repositories when the org input is a full URL', async () => {
    const listAzureRepos = vi.fn().mockResolvedValue([
      {
        provider: 'azure-devops',
        name: 'CosmosDB/CosmosDB',
        remoteUrl: 'https://dev.azure.com/msdata/CosmosDB/_git/CosmosDB',
      },
      {
        provider: 'azure-devops',
        name: 'CosmosDB/Other',
        remoteUrl: 'https://dev.azure.com/msdata/CosmosDB/_git/Other',
      },
    ]);
    const client = {
      listGithubRepos: vi.fn().mockResolvedValue([]),
      listAzureRepos,
      addRepo: vi.fn(),
    } as unknown as ApiClient;
    render(
      <ApiProvider value={client}>
        <RepoPicker onClose={() => {}} onAdded={() => {}} />
      </ApiProvider>,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Azure DevOps' }));
    fireEvent.change(screen.getByLabelText('Azure DevOps organization'), {
      target: {
        value: ' https://dev.azure.com/msdata/CosmosDB/_git/CosmosDB/ ',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    await waitFor(() => expect(listAzureRepos).toHaveBeenCalledWith('https://dev.azure.com/msdata/CosmosDB/_git/CosmosDB/'));
    expect(
      (screen.getByLabelText('Azure DevOps organization') as HTMLInputElement)
        .value,
    ).toBe('https://dev.azure.com/msdata/CosmosDB/_git/CosmosDB/');
    expect((screen.getByLabelText('Search repositories') as HTMLInputElement).value).toBe(
      'CosmosDB/CosmosDB',
    );
    expect(
      screen.getByRole('button', { name: /CosmosDB\/CosmosDB/i }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /CosmosDB\/Other/i })).toBeNull();
  });

  it('shows an actionable Azure empty state when no org is entered', async () => {
    const client = {
      listGithubRepos: vi.fn().mockResolvedValue([]),
      listAzureRepos: vi.fn().mockResolvedValue([]),
      addRepo: vi.fn(),
    } as unknown as ApiClient;
    render(
      <ApiProvider value={client}>
        <RepoPicker onClose={() => {}} onAdded={() => {}} />
      </ApiProvider>,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Azure DevOps' }));

    expect(
      await screen.findByText('Enter an organization to list repositories.'),
    ).toBeTruthy();
    expect(client.listAzureRepos).not.toHaveBeenCalled();
  });

  it.each([
    { location: 'https://msazure.visualstudio.com/Liftr/_git/Liftr.Nginx', org: 'msazure', project: 'Liftr', name: 'Liftr.Nginx' },
    { location: 'https://dev.azure.com/fabrikam/Platform/_git/inventory', org: 'fabrikam', project: 'Platform', name: 'inventory' },
    { location: 'https://contoso.visualstudio.com/DefaultCollection/Team%20Project/_git/my%20repo', org: 'contoso', project: 'Team Project', name: 'my repo' },
  ])('retains $org repository scope through sign-in and retry', async ({ location, org, project, name }) => {
    const repo = { provider: 'azure-devops', name: `${project}/${name}`, remoteUrl: location };
    const listAzureRepos = vi.fn()
      .mockRejectedValueOnce(new ApiError(401, `Studio sign-in is required for ${org}.`))
      .mockResolvedValue([repo]);
    const azureSignIn = vi.fn().mockResolvedValue({ authenticated: true });
    const client = {
      listGithubRepos: vi.fn().mockResolvedValue([]), listAzureRepos, azureSignIn,
    } as unknown as ApiClient;
    render(<ApiProvider value={client}><RepoPicker onClose={() => {}} onAdded={() => {}} /></ApiProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Azure DevOps' }));
    fireEvent.change(screen.getByLabelText('Azure DevOps organization'), { target: { value: location } });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect(await screen.findByText(`Studio sign-in is required for ${org}.`)).toBeInTheDocument();
    expect(screen.getByText(`Organization: ${org} / Project: ${project} / Repository: ${name}. Use the organization, not the project name, or paste the full repository URL.`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Azure DevOps' }));
    await screen.findByRole('button', { name: new RegExp(`${project}/${name}`) });
    expect(azureSignIn).toHaveBeenCalledWith(org);
    expect(JSON.parse(window.localStorage.getItem('azureDevOpsConnections')!)).toContain(org);
    expect(listAzureRepos.mock.calls.every(([target]) => target === location)).toBe(true);
    const calls = listAzureRepos.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(listAzureRepos).toHaveBeenCalledTimes(calls + 1));
    expect(window.localStorage.getItem('azureDevOpsOrg')).toBe(org);
  });

  it('sanitizes Azure backend failures and does not show stale GitHub repositories', async () => {
    const client = {
      listGithubRepos: vi.fn().mockResolvedValue([
        {
          provider: 'github',
          name: 'acme/app',
          remoteUrl: 'https://github.com/acme/app',
        },
      ]),
      listAzureRepos: vi
        .fn()
        .mockRejectedValue(new ApiError(500, 'Internal server error')),
      addRepo: vi.fn(),
    } as unknown as ApiClient;
    render(
      <ApiProvider value={client}>
        <RepoPicker onClose={() => {}} onAdded={() => {}} />
      </ApiProvider>,
    );

    await screen.findByRole('button', { name: /acme\/app/i });
    fireEvent.click(screen.getByRole('tab', { name: 'Azure DevOps' }));
    fireEvent.change(screen.getByLabelText('Azure DevOps organization'), {
      target: { value: 'contoso' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    expect(
      await screen.findByText(
        'Could not load Azure DevOps repositories. Please try again.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /acme\/app/i })).toBeNull();
    expect(screen.queryByText(/Internal server error/i)).toBeNull();
  });

  it('prompts for Azure sign-in when the repository list returns 401', async () => {
    const client = {
      listGithubRepos: vi.fn().mockResolvedValue([]),
      listAzureRepos: vi
        .fn()
        .mockRejectedValue(
          new ApiError(401, 'Sign in to Azure DevOps to load repositories.'),
        ),
      azureSignIn: vi.fn(),
      addRepo: vi.fn(),
    } as unknown as ApiClient;
    render(
      <ApiProvider value={client}>
        <RepoPicker onClose={() => {}} onAdded={() => {}} />
      </ApiProvider>,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Azure DevOps' }));
    fireEvent.change(screen.getByLabelText('Azure DevOps organization'), {
      target: { value: 'contoso' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    expect(await screen.findByText('Azure DevOps access needs attention')).toBeTruthy();
    expect(screen.getByText('Requested organization: contoso. Other Azure DevOps connections are unchanged.')).toBeInTheDocument();
    expect(
      screen.getByText('Sign in to Azure DevOps to load repositories.'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Sign in to Azure DevOps' }),
    ).toBeTruthy();
  });

  it('scopes an Azure sign-in warning to the submitted organization, not another connected org or an unsubmitted URL', async () => {
    const location = 'https://msazure.visualstudio.com/Liftr/_git/Liftr.Nginx';
    const listAzureRepos = vi.fn(async (target: string) => {
      if (target === 'liftr') throw new ApiError(401, 'No usable credential for liftr.');
      return [{ provider: 'azure-devops', name: 'Liftr/Liftr.Nginx', remoteUrl: location }];
    });
    const client = {
      listGithubRepos: vi.fn().mockResolvedValue([]), listAzureRepos, azureSignIn: vi.fn(),
    } as unknown as ApiClient;
    render(<ApiProvider value={client}><RepoPicker onClose={() => {}} onAdded={() => {}} /></ApiProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Azure DevOps' }));
    fireEvent.change(screen.getByLabelText('Azure DevOps organization'), { target: { value: 'liftr' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await screen.findByText('Azure DevOps access needs attention');
    expect(screen.queryByText('Azure DevOps isn’t connected')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Azure DevOps organization'), { target: { value: location } });
    expect(screen.getByText('Requested organization: liftr. Other Azure DevOps connections are unchanged.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await screen.findByRole('button', { name: /Liftr\/Liftr.Nginx/ });
    expect(listAzureRepos).toHaveBeenLastCalledWith(location);
    expect(client.azureSignIn).not.toHaveBeenCalled();
    expect(screen.queryByText('Azure DevOps access needs attention')).not.toBeInTheDocument();
  });

  it('sanitizes GitHub backend failures when switching back from Azure DevOps', async () => {
    const client = {
      listGithubRepos: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new ApiError(500, 'Internal server error')),
      listAzureRepos: vi.fn().mockResolvedValue([
        {
          provider: 'azure-devops',
          name: 'Team/repo',
          remoteUrl: 'https://dev.azure.com/contoso/Team/_git/repo',
        },
      ]),
      addRepo: vi.fn(),
    } as unknown as ApiClient;
    render(
      <ApiProvider value={client}>
        <RepoPicker onClose={() => {}} onAdded={() => {}} />
      </ApiProvider>,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Azure DevOps' }));
    fireEvent.change(screen.getByLabelText('Azure DevOps organization'), {
      target: { value: 'contoso' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await screen.findByRole('button', { name: /Team\/repo/i });

    fireEvent.click(screen.getByRole('tab', { name: 'GitHub' }));

    expect(
      await screen.findByText('Could not load GitHub repositories. Please try again.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Team\/repo/i })).toBeNull();
    expect(screen.queryByText(/Internal server error/i)).toBeNull();
  });
});
