import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { PrReviewPicker, parsePullNumber } from './pr-review-picker.js';
import type { ApiClient } from '../../lib/api.js';
import type { Repository } from '../../lib/types.js';

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

describe('PrReviewPicker manual review', () => {
  function renderPicker(client: Partial<ApiClient>, provider = repo.provider) {
    return render(
      <ApiProvider value={client as ApiClient}>
        <PrReviewPicker
          repo={{ ...repo, provider }}
          onClose={() => {}}
          onCreated={() => {}}
        />
      </ApiProvider>,
    );
  }

  it('reviews GitHub PR URLs by pathname rather than the last digit group', async () => {
    const client: Partial<ApiClient> = {
      listRepoPulls: vi.fn().mockResolvedValue([]),
      createPrFeature: vi.fn().mockResolvedValue({
        id: 'f1',
        name: 'PR 42',
        description: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        summary: null,
        repoId: 'r1',
        checkoutPath: null,
        parentFeatureId: null,
        orderIndex: 0,
      }),
    };
    renderPicker(client);

    fireEvent.change(await screen.findByLabelText('Or paste a PR number or URL'), {
      target: {
        value: 'https://github.com/acme/app/pull/42#discussion_r123456',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));

    await waitFor(() =>
      expect(client.createPrFeature).toHaveBeenCalledWith('r1', 42, null),
    );
  });

  it('rejects arbitrary trailing digits that are not valid PR URLs', async () => {
    const client: Partial<ApiClient> = {
      listRepoPulls: vi.fn().mockResolvedValue([]),
      createPrFeature: vi.fn(),
    };
    renderPicker(client);

    fireEvent.change(await screen.findByLabelText('Or paste a PR number or URL'), {
      target: { value: 'release-2026-09' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));

    expect(
      await screen.findByText('Enter a valid pull request number or URL.'),
    ).toBeInTheDocument();
    expect(client.createPrFeature).not.toHaveBeenCalled();
  });
});
