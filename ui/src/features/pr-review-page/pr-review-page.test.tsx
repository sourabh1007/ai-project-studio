import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { PrReview } from '../../lib/types.js';
import { PrReviewPage } from './pr-review-page.js';

const review: PrReview = {
  featureId: 'f1',
  repoId: 'r1',
  pull: { number: 7, title: 'Add approval', url: 'https://example.test/pr/7' },
  worktreePath: 'C:\\work\\pr-7',
  baseBranch: 'main',
  description: 'desc',
  problemStatement: {
    status: 'ready',
    metaSessionId: null,
    usage: null,
    failure: null,
    activity: [],
    generatedAt: null,
    content: 'Problem',
    sufficient: true,
  },
  changeGraph: {
    status: 'ready',
    metaSessionId: null,
    usage: null,
    failure: null,
    activity: [],
    generatedAt: null,
    projects: [],
    nodes: [],
    edges: [],
  },
  changedFiles: 0,
  timestamps: {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
  },
};

function renderPage(client: Partial<ApiClient>) {
  return render(
    <ApiProvider value={client as ApiClient}>
      <PrReviewPage featureId="f1" liveReview={review} />
    </ApiProvider>,
  );
}

describe('PrReviewPage approval', () => {
  it('approves the pull request and disables the button', async () => {
    const client: Partial<ApiClient> = {
      getPrReview: vi.fn().mockResolvedValue(review),
      listPrReviewComments: vi.fn().mockResolvedValue([]),
      approvePrReview: vi.fn().mockResolvedValue({
        approved: true,
        state: 'approved',
      }),
    };
    renderPage(client);

    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));

    await waitFor(() =>
      expect(client.approvePrReview).toHaveBeenCalledWith('f1'),
    );
    expect(
      await screen.findByRole('button', { name: /Approved/ }),
    ).toBeDisabled();
  });

  it('shows an already-approved label when the reviewer had approved', async () => {
    const client: Partial<ApiClient> = {
      getPrReview: vi.fn().mockResolvedValue(review),
      listPrReviewComments: vi.fn().mockResolvedValue([]),
      approvePrReview: vi.fn().mockResolvedValue({
        approved: true,
        state: 'approved',
        alreadyApproved: true,
      }),
    };
    renderPage(client);

    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));

    expect(
      await screen.findByRole('button', { name: /Already approved/ }),
    ).toBeDisabled();
  });

  it('surfaces approval failures inline', async () => {
    const client: Partial<ApiClient> = {
      getPrReview: vi.fn().mockResolvedValue(review),
      listPrReviewComments: vi.fn().mockResolvedValue([]),
      approvePrReview: vi.fn().mockRejectedValue(new Error('approval failed')),
    };
    renderPage(client);

    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));

    expect(await screen.findByText('approval failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).not.toBeDisabled();
  });
});
