import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveSessions } from './use-active-sessions.js';
import type { ActiveSessionDebug, ActiveSessionsApi, ActiveSessionsSnapshot } from './active-session-types.js';

const snapshot: ActiveSessionsSnapshot = { sampledAt: 10, pollMs: 3000, entries: [] };
const debug: ActiveSessionDebug = { sampledAt: 10, entry: null, state: 'running', activity: ['reading'], output: '', error: null, truncated: false };
const api = () => ({ getActiveSessions: vi.fn(async () => snapshot), getActiveSessionDebug: vi.fn(async () => debug) });
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('one active-session polling cadence', () => {
  it('coalesces bursts of existing stream revisions without additional event streams', async () => {
    const client = api();
    const { rerender } = renderHook(({ revision }) => useActiveSessions(client, null, revision), { initialProps: { revision: 0 } });
    await flush();
    rerender({ revision: 1 });
    rerender({ revision: 2 });
    rerender({ revision: 3 });
    await act(async () => { await vi.advanceTimersByTimeAsync(149); });
    expect(client.getActiveSessions).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(client.getActiveSessions).toHaveBeenCalledTimes(2);
  });

  it('polls only metadata while closed, only the selected output while debugging, aborts and clears timers', async () => {
    const client = api();
    const { result, rerender, unmount } = renderHook(({ selected }) => useActiveSessions(client, selected), { initialProps: { selected: null as string | null } });
    await flush();
    expect(result.current.snapshot).toEqual(snapshot);
    expect(client.getActiveSessionDebug).not.toHaveBeenCalled();
    rerender({ selected: 'warm:s1' });
    await flush();
    expect(client.getActiveSessionDebug).toHaveBeenCalledWith('warm:s1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result.current.debug).toEqual(debug);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(client.getActiveSessionDebug).toHaveBeenCalledTimes(2);
    const options = vi.mocked(client.getActiveSessions).mock.calls.at(-1) as unknown as [{ signal: AbortSignal }];
    unmount();
    expect(options[0].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports stale/unavailable data without inventing zero and retries', async () => {
    const client = api();
    client.getActiveSessions.mockRejectedValueOnce(new Error('auth=hidden'));
    const { result } = renderHook(() => useActiveSessions(client, null));
    await flush();
    expect(result.current.snapshot).toBeNull();
    expect(result.current.error).toContain('unavailable');
    expect(result.current.error).not.toContain('hidden');
    act(() => result.current.refresh());
    await flush();
    expect(result.current.error).toBeNull();
    expect(result.current.snapshot).toEqual(snapshot);
  });

  it('keeps valid counts when a selected output read fails and rejects a previous selection late response', async () => {
    let finish!: (value: ActiveSessionDebug) => void;
    const client = api();
    client.getActiveSessionDebug.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ selected }) => useActiveSessions(client, selected), { initialProps: { selected: 'warm:old' } });
    await flush();
    client.getActiveSessionDebug.mockRejectedValueOnce(new Error('offline'));
    rerender({ selected: 'warm:new' });
    await flush();
    expect(result.current.snapshot).toEqual(snapshot);
    expect(result.current.debugError).toContain('unavailable');
    await act(async () => { finish({ ...debug, output: 'old output' }); });
    expect(result.current.debug).toBeNull();
    act(() => result.current.refresh());
    await flush();
    expect(result.current.debugError).toBeNull();
    expect(result.current.debug).toEqual(debug);
  });

  it('pauses hidden windows, refreshes on visibility and never overlaps slow reads', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    let finish!: (value: ActiveSessionsSnapshot) => void;
    const client: ActiveSessionsApi = {
      getActiveSessions: vi.fn(() => new Promise<ActiveSessionsSnapshot>((resolve) => { finish = resolve; })),
      getActiveSessionDebug: vi.fn(async () => debug),
    };
    const { result } = renderHook(() => useActiveSessions(client, null));
    await flush();
    expect(client.getActiveSessions).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(client.getActiveSessions).toHaveBeenCalledTimes(1);
    await act(async () => { finish(snapshot); });
    expect(result.current.snapshot).toEqual(snapshot);
    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(client.getActiveSessions).toHaveBeenCalledTimes(1);
  });
});
