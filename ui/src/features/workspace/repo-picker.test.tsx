import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { Repository } from '../../lib/types.js';
import { RepoPicker } from './repo-picker.js';

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
});
