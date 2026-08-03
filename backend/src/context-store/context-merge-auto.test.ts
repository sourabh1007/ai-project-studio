import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../session/session-contract.js';
import { createContextMergeAutoTrigger } from './context-merge-auto.js';
import type { ContextMerger } from './context-merge-runner.js';

const devSession = { id: 'dev1', kind: 'dev', scope: 'user' } as unknown as Session;

function harness(options: { autoMergeEnabled?: boolean; reject?: boolean } = {}) {
  const merge = vi.fn(() =>
    options.reject ? Promise.reject(new Error('boom')) : Promise.resolve(null),
  );
  const error = vi.fn();
  const trigger = createContextMergeAutoTrigger({
    merger: { merge } as unknown as ContextMerger,
    config: { autoMergeEnabled: options.autoMergeEnabled ?? true },
    logger: { error },
  });
  return { trigger, merge, error };
}

describe('context-merge-auto', () => {
  it('merges when a dev session ends', () => {
    const h = harness();
    h.trigger.onSessionEnded(devSession);
    expect(h.merge).toHaveBeenCalledWith({ sessionId: 'dev1' });
  });

  it('skips when auto-merge is disabled', () => {
    const h = harness({ autoMergeEnabled: false });
    h.trigger.onSessionEnded(devSession);
    expect(h.merge).not.toHaveBeenCalled();
  });

  it('skips meta and internal sessions', () => {
    const h = harness();
    h.trigger.onSessionEnded({ ...devSession, kind: 'meta' } as Session);
    h.trigger.onSessionEnded({ ...devSession, scope: 'internal' } as Session);
    expect(h.merge).not.toHaveBeenCalled();
  });

  it('logs when the merge rejects', async () => {
    const h = harness({ reject: true });
    h.trigger.onSessionEnded(devSession);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.error).toHaveBeenCalledWith('Auto context merge failed', expect.any(Error));
  });
});
