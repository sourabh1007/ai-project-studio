import { act, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preloadableView, warmViewsWhenIdle } from './lazy-view.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Hello({ name }: { name: string }) {
  return <p>Hello {name}</p>;
}

describe('preloadableView', () => {
  it('renders a preloaded view on the first pass without a fallback', async () => {
    const load = vi.fn(async () => ({ Hello }));
    const view = preloadableView(load, (m) => m.Hello);
    await view.preload();
    await view.preload();
    render(<Suspense fallback={<p>Loading view</p>}><view.Component name="dock" /></Suspense>);
    expect(screen.getByText('Hello dock')).toBeInTheDocument();
    expect(screen.queryByText('Loading view')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('falls back while a cold view loads, then renders it', async () => {
    const view = preloadableView(async () => ({ Hello }), (m) => m.Hello);
    render(<Suspense fallback={<p>Loading view</p>}><view.Component name="cold" /></Suspense>);
    expect(screen.getByText('Loading view')).toBeInTheDocument();
    expect(await screen.findByText('Hello cold')).toBeInTheDocument();
  });

  it('retries after a failed load instead of caching the failure', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('chunk offline'))
      .mockResolvedValueOnce({ Hello });
    const view = preloadableView(load, (m: { Hello: typeof Hello }) => m.Hello);
    await expect(view.preload()).rejects.toThrow('chunk offline');
    await view.preload();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('warmViewsWhenIdle', () => {
  it('warms views one at a time after the delay and ignores failures', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const cancel = warmViewsWhenIdle([
      async () => { order.push('a'); throw new Error('offline'); },
      async () => { order.push('b'); },
      async () => { order.push('c'); },
    ], 500);
    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(order).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(order).toEqual(['a']);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(order).toEqual(['a', 'b', 'c']);
    cancel();
  });

  it('uses idle callbacks when available and stops when cancelled', async () => {
    vi.useFakeTimers();
    const callbacks: Array<() => void> = [];
    const cancelIdle = vi.fn();
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => callbacks.push(callback));
    vi.stubGlobal('cancelIdleCallback', cancelIdle);
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const cancel = warmViewsWhenIdle([first, second], 10);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(callbacks).toHaveLength(1);
    await act(async () => { callbacks[0]!(); await vi.advanceTimersByTimeAsync(0); });
    expect(first).toHaveBeenCalledTimes(1);
    expect(callbacks).toHaveLength(2);
    cancel();
    expect(cancelIdle).toHaveBeenCalledWith(2);
    callbacks[1]!();
    expect(second).not.toHaveBeenCalled();
  });
});
