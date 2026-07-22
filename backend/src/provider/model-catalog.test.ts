import { describe, it, expect } from 'vitest';
import { createModelCatalog } from './model-catalog.js';
import { createProviderRegistry } from './provider-registry.js';
import { createClock } from '../kernel/clock.js';
import type { IAIProvider, ModelInfo } from './provider-contract.js';

function countingProvider(id: string, models: ModelInfo[]) {
  let calls = 0;
  const provider: IAIProvider = {
    id,
    listModels: async () => {
      calls += 1;
      return models;
    },
    startSession: () => {
      throw new Error('unused');
    },
    buildInteractiveCommand: () => {
      throw new Error('unused');
    },
  };
  return { provider, calls: () => calls };
}

describe('model-catalog', () => {
  it('caches within the TTL and refetches after expiry', async () => {
    let t = 1000;
    const clock = createClock(() => t);
    const reg = createProviderRegistry();
    const cp = countingProvider('copilot', [{ id: 'm', label: 'M' }]);
    reg.register(cp.provider);
    const catalog = createModelCatalog(reg, { ttlMs: 500 }, clock);

    await catalog.models('copilot');
    await catalog.models('copilot');
    expect(cp.calls()).toBe(1);

    t += 600; // past TTL
    await catalog.models('copilot');
    expect(cp.calls()).toBe(2);
  });

  it('all() returns every provider catalog', async () => {
    const clock = createClock(() => 0);
    const reg = createProviderRegistry();
    reg.register(countingProvider('a', [{ id: 'a1', label: 'A1' }]).provider);
    reg.register(countingProvider('b', [{ id: 'b1', label: 'B1' }]).provider);
    const catalog = createModelCatalog(reg, { ttlMs: 1000 }, clock);
    const all = await catalog.all();
    expect(all).toEqual({
      a: [{ id: 'a1', label: 'A1' }],
      b: [{ id: 'b1', label: 'B1' }],
    });
  });

  it('invalidate(id) clears one entry; invalidate() clears all', async () => {
    const clock = createClock(() => 0);
    const reg = createProviderRegistry();
    const cp = countingProvider('copilot', [{ id: 'm', label: 'M' }]);
    reg.register(cp.provider);
    const catalog = createModelCatalog(reg, { ttlMs: 100000 }, clock);

    await catalog.models('copilot');
    catalog.invalidate('copilot');
    await catalog.models('copilot');
    expect(cp.calls()).toBe(2);

    catalog.invalidate();
    await catalog.models('copilot');
    expect(cp.calls()).toBe(3);
  });
});
