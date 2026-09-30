import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { PrReviewPicker, parsePullNumber } from './pr-review-picker.js';
import type { ApiClient } from '../../lib/api.js';
import type { Repository } from '../../lib/types.js';
import { TEAM_ROSTER_STORAGE_KEY } from '../../lib/team-roster.js';

const repo: Repository = {
  id: 'r1',
  provider: 'github',
  remoteUrl: 'https://github.com/acme/app',
  name: 'acme/app',
  localPath: 'C:\\repo',
  defaultBranch: 'main',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('parsePullNumber', () => {
  it.each([
    ['42', 'github', 42],
    ['https://github.com/acme/app/pull/42', 'github', 42],
    ['https://github.com/acme/app/pull/42#discussion_r123456', 'github', 42],
    ['https://github.com/org-2026/app-9/pull/42?tab=files', 'github', 42],
    ['https://dev.azure.com/org/project/_git/repo/pullrequest/42?view=discussion', 'azure-devops', 42],
    ['https://contoso.visualstudio.com/project/_git/repo/pullrequest/42#_a=overview', 'azure-devops', 42],
  ])('parses %s for %s', (input, provider, expected) => {
    expect(parsePullNumber(input, provider as Repository['provider'])).toBe(expected);
  });

  it.each([
    ['https://github.com/acme/app/issues/42', 'github'],
    ['https://github.com/acme/app/pull/not-a-number', 'github'],
    ['https://dev.azure.com/org/project/_git/repo/pulls/42', 'azure-devops'],
    ['discussion_r123456', 'github'],
    ['release-2026-09', 'github'],
  ])('rejects invalid input %s for %s', (input, provider) => {
    expect(parsePullNumber(input, provider as Repository['provider'])).toBeNull();
  });
});

describe('PrReviewPicker selection', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  function renderPicker(
    client: Partial<ApiClient>,
    onConfirm: (
      pulls: { number: number; title: string }[],
      reportProgress: (message: string) => void,
    ) => Promise<void>,
    provider = repo.provider,
  ) {
    return render(
      <ApiProvider value={client as ApiClient}>
        <PrReviewPicker
          repo={{ ...repo, provider }}
          onClose={() => {}}
          onConfirm={onConfirm}
        />
      </ApiProvider>,
    );
  }

  it('stages a GitHub PR URL by pathname and confirms the selection', async () => {
    const client: Partial<ApiClient> = {
      listRepoPulls: vi.fn().mockResolvedValue([]),
    };
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderPicker(client, onConfirm);

    fireEvent.change(await screen.findByLabelText('Add by PR number or URL'), {
      target: {
        value: 'https://github.com/acme/app/pull/42#discussion_r123456',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));

    fireEvent.click(screen.getByRole('button', { name: /Start review/ }));

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith(
        [{ number: 42, title: 'PR #42' }],
        expect.any(Function),
      ),
    );
  });

  it('rejects arbitrary trailing digits that are not valid PR URLs', async () => {
    const client: Partial<ApiClient> = {
      listRepoPulls: vi.fn().mockResolvedValue([]),
    };
    const onConfirm = vi.fn();
    renderPicker(client, onConfirm);

    fireEvent.change(await screen.findByLabelText('Add by PR number or URL'), {
      target: { value: 'release-2026-09' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));

    expect(
      await screen.findByText('Enter a valid pull request number or URL.'),
    ).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('stages multiple PRs from the list, caps at ten, and confirms them', async () => {
    const pulls = Array.from({ length: 12 }, (_, i) => ({
      number: i + 1,
      title: `PR ${i + 1}`,
      url: `https://github.com/acme/app/pull/${i + 1}`,
      sourceBranch: `feature/${i + 1}`,
      author: 'octocat',
    }));
    const client: Partial<ApiClient> = {
      listRepoPulls: vi.fn().mockResolvedValue(pulls),
    };
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderPicker(client, onConfirm);

    const choices = await screen.findAllByRole('button', { name: /^#\d+\D/ });
    expect(choices).toHaveLength(12);
    for (const choice of choices.slice(0, 10)) fireEvent.click(choice);
    expect(choices[10]).toBeDisabled();
    fireEvent.click(choices[10]);

    expect(screen.getByText('10 / 10')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Start review/ }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith(
      pulls.slice(0, 10).map(({ number, title }) => ({ number, title })),
      expect.any(Function),
    );
  });

  it('groups open PRs by author in the Team tab', async () => {
    const pulls = [
      { number: 1, title: 'Add cache', url: 'https://github.com/acme/app/pull/1', sourceBranch: 'f/1', author: 'bianca' },
      { number: 2, title: 'Fix retry', url: 'https://github.com/acme/app/pull/2', sourceBranch: 'f/2', author: 'aaron' },
      { number: 3, title: 'Docs pass', url: 'https://github.com/acme/app/pull/3', sourceBranch: 'f/3', author: 'bianca' },
      { number: 4, title: 'Chore', url: 'https://github.com/acme/app/pull/4', sourceBranch: 'f/4', author: null },
    ];
    const client: Partial<ApiClient> = {
      listRepoPulls: vi.fn().mockResolvedValue(pulls),
    };
    renderPicker(client, vi.fn());

    fireEvent.click(await screen.findByRole('tab', { name: /Team/ }));

    // Three distinct authors: aaron, bianca, and the null-author bucket.
    const groupNames = screen
      .getAllByText(/PRs?$/)
      .map((el) => el.previousSibling?.textContent);
    expect(screen.getByText('aaron')).toBeInTheDocument();
    expect(screen.getByText('bianca')).toBeInTheDocument();
    expect(screen.getByText('Unknown author')).toBeInTheDocument();
    // bianca has two PRs grouped together.
    expect(screen.getByText('2 PRs')).toBeInTheDocument();
    expect(groupNames).toContain('aaron');
  });

  it('shows time-in-review badges and reorders by the sort control in the Team tab', async () => {
    const iso = (ms: number) => new Date(Date.now() - ms).toISOString();
    const DAY = 24 * 60 * 60 * 1000;
    const pulls = [
      { number: 1, title: 'Old one', url: 'https://github.com/acme/app/pull/1', sourceBranch: 'f/1', author: 'aaron', createdAt: iso(5 * DAY) },
      { number: 2, title: 'New one', url: 'https://github.com/acme/app/pull/2', sourceBranch: 'f/2', author: 'aaron', createdAt: iso(1 * DAY) },
    ];
    const client: Partial<ApiClient> = {
      listRepoPulls: vi.fn().mockResolvedValue(pulls),
    };
    renderPicker(client, vi.fn());

    fireEvent.click(await screen.findByRole('tab', { name: /Team/ }));

    // Both PRs render a compact age badge (default: longest-in-review first).
    expect(await screen.findByText('5d')).toBeInTheDocument();
    expect(screen.getByText('1d')).toBeInTheDocument();
    const longestOrder = screen
      .getAllByText(/^\dd$/)
      .map((el) => el.textContent);
    expect(longestOrder).toEqual(['5d', '1d']);

    // Switching to "Newest" reverses the order.
    fireEvent.click(screen.getByRole('button', { name: 'Newest' }));
    const newestOrder = screen
      .getAllByText(/^\dd$/)
      .map((el) => el.textContent);
    expect(newestOrder).toEqual(['1d', '5d']);
  });

  it('saves a team roster that filters the Team tab and persists to storage', async () => {
    const pulls = [
      { number: 1, title: 'Add cache', url: 'https://github.com/acme/app/pull/1', sourceBranch: 'f/1', author: 'bianca' },
      { number: 2, title: 'Fix retry', url: 'https://github.com/acme/app/pull/2', sourceBranch: 'f/2', author: 'aaron' },
      { number: 3, title: 'Docs pass', url: 'https://github.com/acme/app/pull/3', sourceBranch: 'f/3', author: 'bianca' },
    ];
    const client: Partial<ApiClient> = {
      listRepoPulls: vi.fn().mockResolvedValue(pulls),
    };
    renderPicker(client, vi.fn());

    fireEvent.click(await screen.findByRole('tab', { name: /Team/ }));
    // Both authors show before a roster is configured.
    expect(screen.getByText('aaron')).toBeInTheDocument();
    expect(screen.getByText('bianca')).toBeInTheDocument();

    // Add aaron to the team from his group header.
    fireEvent.click(screen.getByTitle('Add aaron to my team'));

    // The Team tab now shows only aaron; bianca is filtered out.
    expect(screen.getAllByText('aaron').length).toBeGreaterThan(0);
    expect(screen.queryByText('bianca')).not.toBeInTheDocument();
    // The roster persisted to localStorage for next time.
    expect(
      JSON.parse(window.localStorage.getItem(TEAM_ROSTER_STORAGE_KEY) ?? '[]'),
    ).toEqual(['aaron']);

    // Removing aaron via the roster chip restores the everyone view.
    fireEvent.click(screen.getByLabelText('Remove aaron from my team'));
    expect(screen.getByText('bianca')).toBeInTheDocument();
    expect(
      JSON.parse(window.localStorage.getItem(TEAM_ROSTER_STORAGE_KEY) ?? '[]'),
    ).toEqual([]);
  });
});
