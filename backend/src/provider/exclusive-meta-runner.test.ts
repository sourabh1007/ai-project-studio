import { describe, expect, it, vi } from 'vitest';
import { createExclusiveMetaRunner } from './exclusive-meta-runner.js';
import { createActiveProviderPolicy } from './active-provider.js';
import type { MetaRunner, MetaRunResult } from '../meta/meta-runner.js';

function setup(initialProviderId: string | null = 'copilot') {
  const policy = createActiveProviderPolicy({
    enabledProviderIds: () => ['copilot', 'claude'], isEligible: () => true,
    initialProviderId, saveSelected: () => {},
  });
  const runDetailed = vi.fn<MetaRunner['runDetailed']>();
  const runner = createExclusiveMetaRunner({ runDetailed, run: vi.fn() }, policy);
  return { policy, runDetailed, runner };
}

describe('exclusive meta runner', () => {
  it('acquires synchronously before queued work and pins the provider until settlement', async () => {
    const h = setup();
    let finish!: (result: MetaRunResult) => void;
    h.runDetailed.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const signal = new AbortController().signal;
    const pending = h.runner.runDetailed({ featureId: 'f', prompt: 'p', operationId: 'op', signal });
    expect(h.policy.get().blockers).toEqual([{ kind: 'meta', id: 'op', label: 'Headless AI request' }]);
    expect(h.runDetailed).toHaveBeenCalledWith({
      featureId: 'f', prompt: 'p', operationId: 'op', signal, providerId: 'copilot',
    });
    expect(() => h.policy.select('claude')).toThrow('Stop all CLI work');
    finish({ text: 'done', sessionId: 's' });
    await expect(pending).resolves.toEqual({ text: 'done', sessionId: 's' });
    expect(h.policy.get().blockers).toEqual([]);
    h.policy.select('claude');
    h.runDetailed.mockResolvedValue({ text: 'next', sessionId: 's2' });
    await expect(h.runner.run({ featureId: 'f', prompt: 'p' })).resolves.toBe('next');
    expect(h.runDetailed).toHaveBeenLastCalledWith({ featureId: 'f', prompt: 'p', providerId: 'claude' });
    expect(h.policy.get().blockers).toEqual([]);
  });

  it('releases failed and synchronously throwing requests but never admits inactive requests', async () => {
    const h = setup();
    const failure = new Error('timeout');
    h.runDetailed.mockRejectedValueOnce(failure).mockImplementationOnce(() => { throw failure; });
    await expect(h.runner.run({ featureId: 'f', prompt: 'p' })).rejects.toBe(failure);
    await expect(h.runner.runDetailed({ featureId: 'f', prompt: 'p' })).rejects.toBe(failure);
    expect(h.policy.get().blockers).toEqual([]);
    await expect(h.runner.run({ featureId: 'f', prompt: 'p', providerId: 'claude' })).rejects.toThrow('not the active');
    await expect(setup(null).runner.runDetailed({ featureId: 'f', prompt: 'p' })).rejects.toThrow('Choose an active CLI');
    expect(h.runDetailed).toHaveBeenCalledTimes(2);
  });
});
