import { describe, it, expect } from 'vitest';
import { createUsageTailer, type FileWatcher } from './otel-file-tailer.js';
import type { UsageEvent } from './usage-contract.js';

function usage(turnIndex: number): UsageEvent {
  return {
    sessionId: 's1',
    featureId: 'f1',
    turnIndex,
    provider: 'github',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5.4-mini',
    operation: 'chat',
    inputTokens: 10,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    cost: 0.1,
    nanoAiu: 1,
    serviceRequestId: null,
    startedAt: '1970-01-01T00:00:10.000Z',
    endedAt: '1970-01-01T00:00:12.000Z',
  };
}

function fakeWatcher() {
  let handler: (() => void | Promise<void>) | undefined;
  let closed = false;
  const watcher: FileWatcher = {
    onChange: (cb) => {
      handler = cb;
    },
    close: async () => {
      closed = true;
    },
  };
  return {
    watcher,
    trigger: () => handler?.(),
    isClosed: () => closed,
  };
}

describe('otel-file-tailer', () => {
  it('emits initial events on start and only new events on change', async () => {
    const fw = fakeWatcher();
    let store: UsageEvent[] = [usage(0)];
    const emitted: UsageEvent[] = [];

    const tailer = createUsageTailer('file.jsonl', {
      watch: () => fw.watcher,
      readEvents: async () => store,
      onUsage: (e) => emitted.push(e),
    });

    await tailer.start();
    expect(emitted).toHaveLength(1);

    store = [usage(0), usage(1), usage(2)];
    await fw.trigger();
    expect(emitted.map((e) => e.turnIndex)).toEqual([0, 1, 2]);

    await fw.trigger();
    expect(emitted).toHaveLength(3);
  });

  it('closes the watcher on stop', async () => {
    const fw = fakeWatcher();
    const tailer = createUsageTailer('file.jsonl', {
      watch: () => fw.watcher,
      readEvents: async () => [],
      onUsage: () => {},
    });
    await tailer.start();
    await tailer.stop();
    expect(fw.isClosed()).toBe(true);
  });

  it('is a no-op to stop before start', async () => {
    const fw = fakeWatcher();
    const tailer = createUsageTailer('file.jsonl', {
      watch: () => fw.watcher,
      readEvents: async () => [],
      onUsage: () => {},
    });
    await expect(tailer.stop()).resolves.toBeUndefined();
    expect(fw.isClosed()).toBe(false);
  });
});
