import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnectionStatus } from './use-connection-status.js';
import type { HealthStatus } from '../lib/types.js';

const api = vi.hoisted(() => ({ checkHealth: vi.fn() }));
vi.mock('../app/api-context.js', () => ({ useApi: () => api }));
vi.mock('../lib/desktop-bridge.js', () => ({ desktopBridge: () => undefined }));

const health: HealthStatus = {
  status: 'ok', uptimeMs: 1,
  resources: {
    status: 'pressure', reasons: ['high-cpu'], cpuPercent: 99,
    measuredAt: 1_000, staleAfterMs: 30_000,
    freeMemoryBytes: 8e9, totalMemoryBytes: 16e9, eventLoopDelayMs: 20,
  },
};

beforeEach(() => { api.checkHealth.mockReset(); });
afterEach(() => vi.useRealTimers());

describe('shared health measurements', () => {
  it('uses the existing health result without an extra request', async () => {
    api.checkHealth.mockResolvedValue(health);
    const { result } = renderHook(() => useConnectionStatus());
    await waitFor(() => expect(result.current.resources).toEqual(health.resources));
    expect(api.checkHealth).toHaveBeenCalledTimes(1);
  });
  it('clears measurements on first failed probe, independently of banner hysteresis', async () => {
    vi.useFakeTimers();
    api.checkHealth.mockResolvedValueOnce(health).mockRejectedValue(new Error('timeout'));
    const { result, unmount } = renderHook(() => useConnectionStatus());
    await act(async () => {});
    expect(result.current.resources).toEqual(health.resources);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(result.current.state).toBe('online');
    expect(result.current.probeFailed).toBe(true);
    expect(result.current.resources).toBeUndefined();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(api.checkHealth).toHaveBeenCalledTimes(2);
  });
  it('does not overlap probes or apply a late result after unmount', async () => {
    vi.useFakeTimers();
    let resolve!: (value: HealthStatus) => void;
    api.checkHealth.mockReturnValue(new Promise<HealthStatus>((done) => { resolve = done; }));
    const { result, unmount } = renderHook(() => useConnectionStatus());
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.checkHealth).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { resolve(health); });
    expect(result.current.resources).toBeUndefined();
  });
});
