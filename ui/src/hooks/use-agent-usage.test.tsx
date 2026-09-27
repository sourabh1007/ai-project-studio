import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentUsage } from './use-agent-usage.js';
import type { MetaOperationSummary } from '../features/meta-operations/meta-operation-types.js';
import { applyStreamEvent, initialLiveState } from '../lib/stream.js';

const api = vi.hoisted(() => ({ listMetaOperations: vi.fn() }));
vi.mock('../app/api-context.js', () => ({ useApi: () => api }));
const operation = (nanoAiu: number): MetaOperationSummary => ({
  operationId: 'one', featureId: 'f', label: 'Review board', sessionIds: ['s'],
  state: 'completed', outcome: 'returned',
  usage: { nanoAiu, credits: 99, inputTokens: 1, outputTokens: 2 },
} as MetaOperationSummary);
class Source extends EventTarget {
  static instances: Source[] = [];
  close = vi.fn();
  constructor(public url: string) { super(); Source.instances.push(this); }
}
beforeEach(() => {
  api.listMetaOperations.mockReset();
  Source.instances = [];
  vi.stubGlobal('EventSource', Source);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('useAgentUsage', () => {
  it('reuses shared live state for per-PR and batch totals without opening another stream', async () => {
    api.listMetaOperations.mockImplementation(async ({ featureId }: { featureId: string }) => ({
      items: [{ ...operation(featureId === 'f' ? 2e9 : 3e9), featureId, operationId: featureId }],
      nextCursor: null,
    }));
    const { result, rerender } = renderHook(({ ids, live }) => useAgentUsage(ids, 'Review board', undefined, live), {
      initialProps: { ids: ['f', 'g', 'f'], live: initialLiveState },
    });
    await waitFor(() => expect(result.current.aic).toBe(5));
    expect(result.current.byFeature.f.aic).toBe(2);
    expect(result.current.byFeature.g.aic).toBe(3);
    expect(Source.instances).toHaveLength(0);
    expect(api.listMetaOperations).toHaveBeenCalledTimes(2);
    rerender({ ids: ['g', 'f'], live: initialLiveState });
    expect(api.listMetaOperations).toHaveBeenCalledTimes(2);
    api.listMetaOperations.mockResolvedValue({ items: [operation(4e9)], nextCursor: null });
    rerender({
      ids: ['f', 'g'],
      live: applyStreamEvent(initialLiveState, { type: 'meta.usage.updated', featureId: 'f', operationId: 'one' }),
    });
    await waitFor(() => expect(result.current.aic).toBe(4));
    expect(result.current.incompleteFeatures).toBe(1);
    expect(result.current.byFeature.g.aic).toBeNull();
  });

  it('marks batch refresh failure explicitly instead of presenting partial requests as complete totals', async () => {
    api.listMetaOperations.mockResolvedValueOnce({ items: [operation(2e9)], nextCursor: null })
      .mockRejectedValueOnce(new Error('second feature unavailable'));
    const { result } = renderHook(() => useAgentUsage(['f', 'g'], 'Review board', undefined, initialLiveState));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.aic).toBeNull();
    expect(result.current.incompleteFeatures).toBe(2);
  });
  it('loads all pages and replaces, rather than adds, live capture corrections', async () => {
    api.listMetaOperations
      .mockResolvedValueOnce({ items: [operation(2e9)], nextCursor: 'more' })
      .mockResolvedValueOnce({ items: [{ ...operation(3e9), operationId: 'two' }], nextCursor: null })
      .mockResolvedValue({ items: [operation(1e9)], nextCursor: null });
    const { result, unmount } = renderHook(() => useAgentUsage('f', 'Review board'));
    await waitFor(() => expect(result.current.aic).toBe(5));
    expect(api.listMetaOperations).toHaveBeenCalledWith({ featureId: 'f', after: 'more', limit: 100 });
    act(() => Source.instances[0].dispatchEvent(new MessageEvent('meta.usage.updated', { data: '{"featureId":"other"}' })));
    expect(api.listMetaOperations).toHaveBeenCalledTimes(2);
    act(() => Source.instances[0].dispatchEvent(new MessageEvent('meta.usage.updated', { data: '{"featureId":"f"}' })));
    await waitFor(() => expect(result.current.aic).toBe(1));
    unmount();
    expect(Source.instances[0].close).toHaveBeenCalled();
  });
  it('repairs missed events on polling and reconnect while retaining stale measured data on failure', async () => {
    vi.useFakeTimers();
    api.listMetaOperations.mockResolvedValueOnce({ items: [operation(2e9)], nextCursor: null })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ items: [operation(4e9)], nextCursor: null });
    const { result, unmount } = renderHook(() => useAgentUsage('f', 'Review board'));
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(result.current).toMatchObject({ aic: 2, error: true });
    await act(async () => { Source.instances[0].dispatchEvent(new Event('open')); });
    expect(result.current).toMatchObject({ aic: 4, error: false });
    unmount();
  });
  it('prevents stale in-flight responses from leaking across feature switches', async () => {
    let resolve!: (value: unknown) => void;
    api.listMetaOperations.mockReturnValueOnce(new Promise((done) => { resolve = done; }))
      .mockResolvedValue({ items: [], nextCursor: null });
    const { result, rerender, unmount } = renderHook(({ feature }) => useAgentUsage(feature, 'Review board'), {
      initialProps: { feature: 'f' },
    });
    rerender({ feature: 'new' });
    await act(async () => { resolve({ items: [operation(2e9)], nextCursor: null }); });
    expect(result.current.aic).toBeNull();
    expect(Source.instances[0].close).toHaveBeenCalled();
    unmount();
  });
});
