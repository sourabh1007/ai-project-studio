import { describe, it, expect, vi } from 'vitest';
import type { AbortTracker } from '../kernel/abort-tracker.js';
import { createOwnedMetaRunner } from './owned-meta-runner.js';
import type { MetaRequest, MetaRunResult, MetaRunner } from './meta-runner.js';

describe('createOwnedMetaRunner', () => {
  it('runs through the owner with the caller signal', async () => {
    let seenSignal: AbortSignal | undefined;
    let seenCallerSignal: AbortSignal | undefined;
    const owner: Pick<AbortTracker, 'own'> = {
      own: vi.fn((run, signal?: AbortSignal) => {
        seenCallerSignal = signal;
        return run(signal ?? new AbortController().signal);
      }) as AbortTracker['own'],
    };
    const base: MetaRunner = {
      run: async () => 'unused',
      runDetailed: async (request: MetaRequest): Promise<MetaRunResult> => {
        seenSignal = request.signal;
        return { text: 'ok', sessionId: 'm1' };
      },
    };
    const controller = new AbortController();
    const runner = createOwnedMetaRunner(base, owner);
    await expect(
      runner.runDetailed({ featureId: 'f1', prompt: 'hi', signal: controller.signal }),
    ).resolves.toEqual({ text: 'ok', sessionId: 'm1' });
    expect(owner.own).toHaveBeenCalledTimes(1);
    expect(seenCallerSignal).toBe(controller.signal);
    expect(seenSignal).toBe(controller.signal);
  });

  it('preserves the plain-text run contract', async () => {
    const base: MetaRunner = {
      run: async () => 'unused',
      runDetailed: async () => ({ text: 'ok', sessionId: 'm2' }),
    };
    const runner = createOwnedMetaRunner(base, {
      own: async (run, signal) => run(signal ?? new AbortController().signal),
    });
    await expect(runner.run({ featureId: 'f1', prompt: 'hi' })).resolves.toBe('ok');
  });
});
