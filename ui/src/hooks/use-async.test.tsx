import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAsync } from './use-async.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('useAsync', () => {
  it('keeps an item mutation when an older list request resolves afterwards', async () => {
    const old = deferred<string[]>();
    const loader = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(['New item', 'Current item']);
    const { result } = renderHook(() => useAsync(loader, []));
    act(() => result.current.updateData(['New item']));
    await act(async () => old.resolve(['Deleted item']));
    expect(result.current.data).toEqual(['New item']);
    expect(result.current.loading).toBe(false);
    act(() => result.current.reload());
    await act(async () => {});
    expect(result.current.data).toEqual(['New item', 'Current item']);
  });

  it('coalesces repeated reloads while one request is active into one trailing refresh', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const loader = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { result } = renderHook(() => useAsync(loader, []));
    expect(loader).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.reload();
      result.current.reload();
      result.current.reload();
    });
    expect(loader).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve('old'));
    expect(loader).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(true);

    await act(async () => second.resolve('fresh'));
    expect(result.current.data).toBe('fresh');
    expect(result.current.loading).toBe(false);
  });

  it('reports a loader that throws synchronously instead of staying loading', async () => {
    const loader = vi.fn(() => {
      throw new Error('bridge unavailable');
    });
    const { result } = renderHook(() => useAsync(loader, []));
    await act(async () => {});
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe('bridge unavailable');
  });
});
