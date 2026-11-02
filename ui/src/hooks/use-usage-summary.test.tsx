import { act, fireEvent, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../app/api-context.js';
import { createApiClient } from '../lib/api.js';
import { useUsageSummary } from './use-usage-summary.js';

const snapshot = { features: {}, unattributed: null };

function setup() {
  vi.useFakeTimers();
  const api = createApiClient();
  const request = vi.spyOn(api, 'getUsageSummary').mockResolvedValue(snapshot);
  const wrapper = ({ children }: PropsWithChildren) => <ApiProvider value={api}>{children}</ApiProvider>;
  return { request, wrapper };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useUsageSummary', () => {
  it('fetches once while idle and throttles continuous invalidations without losing the final one', async () => {
    const { request, wrapper } = setup();
    const { result, rerender } = renderHook(({ revision }) => useUsageSummary(revision), {
      wrapper, initialProps: { revision: 0 },
    });
    await act(async () => {});
    expect(result.current.data).toEqual(snapshot);
    for (let revision = 1; revision <= 10; revision++) {
      rerender({ revision });
      await act(async () => { vi.advanceTimersByTime(100); });
    }
    expect(request).toHaveBeenCalledTimes(2);
    rerender({ revision: 11 });
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(request).toHaveBeenCalledTimes(3);
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('keeps stale data on failure and retries even without another stream event', async () => {
    const { request, wrapper } = setup();
    const { result, rerender } = renderHook(({ revision }) => useUsageSummary(revision), {
      wrapper, initialProps: { revision: 0 },
    });
    await act(async () => {});
    request.mockRejectedValueOnce(new Error('Offline'));
    rerender({ revision: 1 });
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(result.current.data).toEqual(snapshot);
    expect(result.current.error).toBe('Offline');
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(result.current.error).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not overlap requests and catches an invalidation during a running snapshot', async () => {
    const { request, wrapper } = setup();
    let finish!: (value: typeof snapshot) => void;
    request.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { rerender } = renderHook(({ revision }) => useUsageSummary(revision), {
      wrapper, initialProps: { revision: 0 },
    });
    rerender({ revision: 1 });
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => finish(snapshot));
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('aborts a hung request and recovers on the next interval', async () => {
    const { request, wrapper } = setup();
    request.mockImplementationOnce((options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }));
    const { result } = renderHook(() => useUsageSummary(0), { wrapper });
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(request.mock.calls[0][0]?.signal?.aborted).toBe(true);
    expect(result.current.error).toMatch(/timed out/);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(result.current.data).toEqual(snapshot);
    expect(result.current.error).toBeNull();
  });

  it('aborts on unmount and discards a late response', async () => {
    const { request, wrapper } = setup();
    let finish!: (value: typeof snapshot) => void;
    request.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { unmount } = renderHook(() => useUsageSummary(0), { wrapper });
    unmount();
    expect(request.mock.calls[0][0]?.signal?.aborted).toBe(true);
    await act(async () => finish(snapshot));
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('pauses while hidden and refreshes on visibility, reconnect and explicit retry', async () => {
    const { request, wrapper } = setup();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const { result } = renderHook(() => useUsageSummary(0), { wrapper });
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(request).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    await act(async () => { fireEvent(document, new Event('visibilitychange')); });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent(window, new Event('online')); });
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => result.current.retry());
    expect(request).toHaveBeenCalledTimes(3);
  });
});
