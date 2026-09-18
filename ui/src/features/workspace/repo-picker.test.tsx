import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

    await waitFor(() => expect(listAzureRepos).toHaveBeenCalledWith('msdata'));
    expect(
      (screen.getByLabelText('Azure DevOps organization') as HTMLInputElement)
        .value,
    ).toBe('msdata');
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

    expect(await screen.findByText('Azure DevOps isn’t connected')).toBeTruthy();
    expect(
      screen.getByText('Sign in to Azure DevOps to load repositories.'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Sign in to Azure DevOps' }),
    ).toBeTruthy();
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
