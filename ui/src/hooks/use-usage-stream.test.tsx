import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUsageStream } from './use-usage-stream.js';
import { MAX_LIVE_EVENT_CHARACTERS, liveSignal } from '../lib/stream.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, EventListener>();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventListener): void {
    this.listeners.set(name, listener);
  }

  removeEventListener(name: string, listener: EventListener): void {
    if (this.listeners.get(name) === listener) {
      this.listeners.delete(name);
    }
  }

  emit(name: string, data: string): void {
    this.listeners.get(name)?.(new MessageEvent(name, { data }));
  }
}

describe('useUsageStream', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opts out of redundant output and does not accumulate frames from legacy servers', () => {
    const { result, unmount } = renderHook(() => useUsageStream());
    const source = FakeEventSource.instances[0];
    expect(source.url).toMatch(/\/stream\?output=0$/);
    expect(source.listeners.has('session.output')).toBe(false);
    const initial = result.current;
    act(() => {
      for (let index = 0; index < 1000; index++) {
        source.emit('session.output', JSON.stringify({
          sessionId: `session-${index}`,
          event: { type: 'stdout', line: 'output'.repeat(100) },
        }));
      }
    });
    expect(result.current).toBe(initial);
    expect(result.current).not.toHaveProperty('outputBySession');
    act(() => {
      source.emit('session.file', JSON.stringify({ sessionId: 's1' }));
    });
    expect(result.current.fileChangesBySession.s1).toBe(1);
    unmount();
    expect(source.listeners.size).toBe(0);
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('reports stream gaps, refreshes the stats signal on reconnect and bounds legacy payload parsing', () => {
    const { result, unmount } = renderHook(() => useUsageStream());
    const source = FakeEventSource.instances[0];
    act(() => source.emit('error', ''));
    expect(result.current.streamInterrupted).toBe(true);
    expect(result.current.usageHistoryTruncated).toBe(true);
    const revision = liveSignal(result.current);
    act(() => source.emit('open', ''));
    expect(liveSignal(result.current)).toBe(revision + 1);
    expect(result.current.streamInterrupted).toBe(true);
    act(() => source.emit('usage.recorded', 'x'.repeat(MAX_LIVE_EVENT_CHARACTERS + 1)));
    expect(result.current.liveCacheTruncated).toBe(true);
    expect(result.current.usageByKey).toEqual({});
    unmount();
    expect(source.listeners.size).toBe(0);
  });
});
