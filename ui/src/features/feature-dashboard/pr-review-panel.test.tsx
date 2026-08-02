import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { ApiError, type ApiClient } from '../../lib/api.js';
import type { PrReview } from '../../lib/types.js';
import { PrReviewPanel } from './pr-review-panel.js';

function review(
  status: PrReview['status'],
  overrides: Partial<PrReview> = {},
): PrReview {
  return {
    featureId: 'f1',
    repoId: 'r1',
    pull: { number: 7, title: 'Add retry', url: 'https://example.com/pr/7' },
    worktreePath: 'C:\\wt',
    baseBranch: 'main',
    status,
    summary: status === 'ready' ? 'Adds retry logic.' : null,
    coreAnalysis: status === 'ready' ? '- wraps the client' : null,
    changedFiles: status === 'ready' ? 3 : null,
    timestamps: {
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:01Z',
      generatedAt: status === 'ready' ? '2025-01-01T00:00:01Z' : null,
    },
    failure: null,
    ...overrides,
  };
}

function renderPanel(client: Partial<ApiClient>, liveReview?: PrReview) {
  return render(
    <ApiProvider value={client as unknown as ApiClient}>
      <PrReviewPanel featureId="f1" liveReview={liveReview} />
    </ApiProvider>,
  );
}

describe('PrReviewPanel', () => {
  it('renders a ready review with summary and core analysis', async () => {
    const getPrReview = vi.fn().mockResolvedValue(review('ready'));
    renderPanel({ getPrReview });

    expect(await screen.findByText('Adds retry logic.')).toBeInTheDocument();
    expect(screen.getByText('- wraps the client')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText(/#7 Add retry/)).toBeInTheDocument();
    expect(screen.getByText(/3 files changed/)).toBeInTheDocument();
  });

  it('shows the analyzing animation while generating', async () => {
    const getPrReview = vi.fn().mockResolvedValue(review('generating'));
    renderPanel({ getPrReview });

    expect(await screen.findByText(/Analyzing pull request/)).toBeInTheDocument();
    expect(screen.getByText('Analyzing')).toBeInTheDocument();
  });

  it('surfaces a generation failure with a retry action', async () => {
    const getPrReview = vi
      .fn()
      .mockResolvedValue(
        review('failed', {
          failure: { message: 'provider exited 1', failedAt: '2025-01-01T00:00:02Z' },
        }),
      );
    const refreshPrReview = vi.fn().mockResolvedValue(review('generating'));
    renderPanel({ getPrReview, refreshPrReview });

    expect(await screen.findByText('provider exited 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(refreshPrReview).toHaveBeenCalledWith('f1'));
  });

  it('renders nothing for a non-PR feature (404)', async () => {
    const getPrReview = vi.fn().mockRejectedValue(new ApiError(404, 'not found'));
    const { container } = renderPanel({ getPrReview });
    await waitFor(() => expect(getPrReview).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a non-404 load error', async () => {
    const getPrReview = vi.fn().mockRejectedValue(new Error('Offline'));
    renderPanel({ getPrReview });
    expect(await screen.findByText('Offline')).toBeInTheDocument();
  });

  it('prefers a live review and updates when a new one streams in', async () => {
    const getPrReview = vi.fn().mockResolvedValue(review('generating'));
    const { rerender } = render(
      <ApiProvider value={{ getPrReview } as unknown as ApiClient}>
        <PrReviewPanel featureId="f1" liveReview={review('generating')} />
      </ApiProvider>,
    );
    expect(await screen.findByText(/Analyzing pull request/)).toBeInTheDocument();

    rerender(
      <ApiProvider value={{ getPrReview } as unknown as ApiClient}>
        <PrReviewPanel featureId="f1" liveReview={review('ready')} />
      </ApiProvider>,
    );
    expect(await screen.findByText('Adds retry logic.')).toBeInTheDocument();
  });

  it('surfaces a refresh error', async () => {
    const getPrReview = vi.fn().mockResolvedValue(review('ready'));
    const refreshPrReview = vi.fn().mockRejectedValue(new Error('Busy'));
    renderPanel({ getPrReview, refreshPrReview });

    await screen.findByText('Adds retry logic.');
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByText('Busy')).toBeInTheDocument();
  });

  it('shows a placeholder when a pending review has no content yet', async () => {
    const getPrReview = vi
      .fn()
      .mockResolvedValue(review('ready', { summary: null, coreAnalysis: null }));
    renderPanel({ getPrReview });
    expect(
      await screen.findByText(/review will appear here/i),
    ).toBeInTheDocument();
  });
});
