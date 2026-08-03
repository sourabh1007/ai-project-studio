import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { RemotePullRequest } from '../../lib/types.js';
import { GroupPrPicker } from './group-pr-picker.js';

function pull(overrides: Partial<RemotePullRequest> & { number: number }): RemotePullRequest {
  return {
    provider: 'github',
    title: `PR ${overrides.number}`,
    url: `https://github.com/o/r/pull/${overrides.number}`,
    sourceBranch: 'feat',
    author: 'octocat',
    ...overrides,
  };
}

describe('GroupPrPicker', () => {
  it('picks a listed pull request', async () => {
    const client = {
      listRepoPulls: vi.fn().mockResolvedValue([pull({ number: 7 })]),
    } as unknown as ApiClient;
    const onPick = vi.fn();
    render(
      <ApiProvider value={client}>
        <GroupPrPicker repoId="r1" onClose={() => {}} onPick={onPick} />
      </ApiProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /PR 7/ }));
    expect(onPick).toHaveBeenCalledWith({
      number: 7,
      title: 'PR 7',
      url: 'https://github.com/o/r/pull/7',
    });
  });

  it('filters the list by search query', async () => {
    const client = {
      listRepoPulls: vi
        .fn()
        .mockResolvedValue([pull({ number: 1 }), pull({ number: 2, title: 'Special' })]),
    } as unknown as ApiClient;
    render(
      <ApiProvider value={client}>
        <GroupPrPicker repoId="r1" onClose={() => {}} onPick={() => {}} />
      </ApiProvider>,
    );
    await screen.findByRole('button', { name: /Special/ });
    fireEvent.change(screen.getByLabelText('Search pull requests'), {
      target: { value: 'Special' },
    });
    expect(screen.queryByRole('button', { name: /PR 1/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Special/ })).toBeInTheDocument();
  });

  it('shows an empty state when there are no open pulls', async () => {
    const client = {
      listRepoPulls: vi.fn().mockResolvedValue([]),
    } as unknown as ApiClient;
    render(
      <ApiProvider value={client}>
        <GroupPrPicker repoId="r1" onClose={() => {}} onPick={() => {}} />
      </ApiProvider>,
    );
    expect(
      await screen.findByText('No open pull requests found.'),
    ).toBeInTheDocument();
  });
});
