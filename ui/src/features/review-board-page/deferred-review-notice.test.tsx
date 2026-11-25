import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { PrReview } from '../../lib/types.js';
import { DeferredReviewNotice } from './deferred-review-notice.js';

function review(deferred: boolean, status: 'pending' | 'ready' = 'pending'): PrReview {
  const step = { status, metaSessionId: null, usage: null, failure: null, activity: [], generatedAt: null };
  return {
    featureId: 'feature', repoId: 'repo', pull: { number: 1, title: 'Imported PR', url: 'https://example.test/1' },
    worktreePath: 'C:\\repo', headSha: 'head', baseBranch: 'main', description: null, analysisDeferred: deferred,
    problemStatement: { ...step, content: null, sufficient: false },
    changeGraph: { ...step, projects: [], nodes: [], edges: [] },
    changedFiles: 0, timestamps: { createdAt: '2026-01-01', updatedAt: '2026-01-01' },
  };
}

describe('import-only review preparation', () => {
  afterEach(() => vi.useRealTimers());
  it('does not prepare or analyze an imported PR before explicit confirmation', async () => {
    const api = { getPrReview: vi.fn().mockResolvedValue(review(true)),
      preparePrReview: vi.fn().mockResolvedValue(review(false, 'ready')) } as unknown as ApiClient;
    const onReady = vi.fn();
    render(<ApiProvider value={api}><DeferredReviewNotice featureId="feature" error="Evidence is not ready"
      onReady={onReady} onRetry={vi.fn()} /></ApiProvider>);
    const button = await screen.findByRole('button', { name: 'Prepare review' });
    expect(api.preparePrReview).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(api.preparePrReview).toHaveBeenCalledWith('feature');
  });

  it('polls bounded evidence reads after preparation without dispatching duplicate preparation', async () => {
    vi.useFakeTimers();
    const api = { getPrReview: vi.fn().mockResolvedValueOnce(review(true)).mockResolvedValue(review(false, 'ready')),
      preparePrReview: vi.fn().mockResolvedValue(review(false)) } as unknown as ApiClient;
    const onReady = vi.fn();
    render(<ApiProvider value={api}><DeferredReviewNotice featureId="feature" error="Evidence is not ready"
      onReady={onReady} onRetry={vi.fn()} /></ApiProvider>);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare review' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Preparation in progress' })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(onReady).toHaveBeenCalledOnce();
    expect(api.preparePrReview).toHaveBeenCalledOnce();
    expect(api.getPrReview).toHaveBeenCalledTimes(2);
  });

  it('surfaces preparation failures and allows an explicit retry', async () => {
    const api = { getPrReview: vi.fn().mockResolvedValue(review(true)),
      preparePrReview: vi.fn().mockRejectedValueOnce(new Error('Preparation queue is full.')).mockResolvedValue(review(false, 'ready')) } as unknown as ApiClient;
    const onReady = vi.fn();
    render(<ApiProvider value={api}><DeferredReviewNotice featureId="feature" error="Evidence is not ready"
      onReady={onReady} onRetry={vi.fn()} /></ApiProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare review' }));
    await screen.findByText('Preparation queue is full.');
    expect(onReady).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare review' }));
    await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  });
});
