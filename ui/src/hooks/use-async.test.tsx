import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAsync } from './use-async.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('useAsync', () => {
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
});
