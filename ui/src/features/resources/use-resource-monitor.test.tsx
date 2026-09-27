import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import { useResourceMonitor } from './use-resource-monitor.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function wrapper(getAppResources: ReturnType<typeof vi.fn>) {
  const api = { getAppResources } as unknown as ApiClient;
  return ({ children }: { children: ReactNode }) => <ApiProvider value={api}>{children}</ApiProvider>;
}
describe('resource polling', () => {
  it('coalesces slow requests and stops polling after unmount', async () => {
    vi.useFakeTimers();
    let resolve!: (value: object) => void;
    const get = vi.fn(() => new Promise((r) => { resolve = r; }));
    const view = renderHook(() => useResourceMonitor(true), { wrapper: wrapper(get) });
    await act(async () => { await Promise.resolve(); });
    expect(get).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(get).toHaveBeenCalledOnce();
    await act(async () => { resolve({ measuredAt: 123 }); });
    expect(view.result.current.snapshot).toEqual({ measuredAt: 123 });
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retains previous measurements but surfaces errors and recovers on retry', async () => {
    vi.useFakeTimers();
    const get = vi.fn().mockResolvedValueOnce({ measuredAt: 1000 }).mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ measuredAt: 5000 });
    const view = renderHook(() => useResourceMonitor(true), { wrapper: wrapper(get) });
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(view.result.current.error).toBe('Offline');
    expect(view.result.current.snapshot).toEqual({ measuredAt: 1000 });
    await act(async () => { await view.result.current.refresh(); });
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.snapshot).toEqual({ measuredAt: 5000 });
    view.unmount();
  });
  it('pauses automatic reads for hidden windows and refreshes on visibility return', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const get = vi.fn().mockResolvedValue({});
    const view = renderHook(() => useResourceMonitor(false), { wrapper: wrapper(get) });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(get).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(get).toHaveBeenCalledOnce();
    view.unmount();
  });
});
