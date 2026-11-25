import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { ReviewBoard, ReviewDiscussion, ReviewPublication } from '../../lib/types.js';
import { useReviewLiveContext } from './use-review-live-context.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function board(runId: string): ReviewBoard {
  return { pull: { headSha: 'head' }, run: { id: runId, revision: 1 } } as ReviewBoard;
}

const publication: ReviewPublication = {
  key: 'operation', status: 'pending', input: { body: 'Concern', expectedRunId: 'run-two', publicationKey: 'key' },
  startedAt: '2026-01-01',
};

describe('live review context', () => {
  it.each(['feature', 'run'])('ignores late responses and callbacks after a %s switch', async (transition) => {
    const oldDiscussion = deferred<ReviewDiscussion>();
    const oldPublications = deferred<ReviewPublication[]>();
    const nextDiscussion = deferred<ReviewDiscussion>();
    const nextPublications = deferred<ReviewPublication[]>();
    const api = {
      getReviewBoardDiscussion: vi.fn().mockReturnValueOnce(oldDiscussion.promise).mockReturnValueOnce(nextDiscussion.promise),
      getReviewBoardPublications: vi.fn().mockReturnValueOnce(oldPublications.promise).mockReturnValueOnce(nextPublications.promise),
    } as unknown as ApiClient;
    const wrapper = ({ children }: { children: ReactNode }) => <ApiProvider value={api}>{children}</ApiProvider>;
    const { result, rerender } = renderHook(({ featureId, runId }) => useReviewLiveContext(featureId, board(runId)), {
      wrapper, initialProps: { featureId: 'first', runId: 'run-one' },
    });
    const oldUpdate = result.current.updatePublication;
    rerender({ featureId: transition === 'feature' ? 'second' : 'first', runId: 'run-two' });
    await act(async () => {
      oldDiscussion.resolve({ matches: { old: [{ id: 'old', status: 'resolved', url: 'https://example.test/old' }] }, warnings: [] });
      oldPublications.resolve([{ ...publication, key: 'old-operation' }]);
      oldUpdate({ ...publication, key: 'stale-callback' });
    });
    expect(result.current.discussion).toBeUndefined();
    expect(result.current.publications).toEqual([]);
    expect(result.current.publicationsLoading).toBe(true);
    await act(async () => {
      nextDiscussion.resolve({ matches: {}, warnings: ['Exact matching is incomplete.'] });
      nextPublications.resolve([publication]);
    });
    expect(result.current.publications).toEqual([publication]);
    expect(result.current.discussion?.warnings).toEqual(['Exact matching is incomplete.']);
    expect(result.current.publicationsLoading).toBe(false);
  });

  it('surfaces read failures and retries live context on focus without changing frozen analysis', async () => {
    const api = {
      getReviewBoardDiscussion: vi.fn().mockRejectedValueOnce(new Error('Discussion unavailable')).mockResolvedValue({ matches: {}, warnings: [] }),
      getReviewBoardPublications: vi.fn().mockRejectedValueOnce(new Error('History unavailable')).mockResolvedValue([publication]),
    } as unknown as ApiClient;
    const value = board('run-two');
    const wrapper = ({ children }: { children: ReactNode }) => <ApiProvider value={api}>{children}</ApiProvider>;
    const { result } = renderHook(() => useReviewLiveContext('feature', value), { wrapper });
    await waitFor(() => expect(result.current.publicationsError).toBe('History unavailable'));
    expect(result.current.discussion?.warnings).toEqual(['Discussion unavailable']);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(result.current.publications).toEqual([publication]));
    expect(result.current.publicationsError).toBeNull();
    expect(result.current.discussion?.warnings).toEqual([]);
    expect(value.run?.revision).toBe(1);
    act(() => result.current.updatePublication({ ...publication, key: 'server-key', status: 'posted' }));
    expect(result.current.publications).toEqual([{ ...publication, key: 'server-key', status: 'posted' }]);
    expect(value.run?.revision).toBe(1);
  });
});
