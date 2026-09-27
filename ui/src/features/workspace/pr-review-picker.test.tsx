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

describe('PrReviewPicker selection', () => {
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

    // Select the first eleven; only ten may be staged.
    for (let i = 1; i <= 11; i += 1) {
      fireEvent.click(
        await screen.findByRole('button', { name: new RegExp(`^#${i}\\D`) }),
      );
    }

    expect(screen.getByText('10 / 10')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Start review/ }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect((onConfirm.mock.calls[0][0] as unknown[]).length).toBe(10);
  });
});
