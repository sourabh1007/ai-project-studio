import { describe, it, expect } from 'vitest';
import { createProviderResolver } from './provider-resolver.js';
import { createProviderRegistry } from './provider-registry.js';
import type { IAIProvider, ModelInfo } from './provider-contract.js';
import { ValidationError } from '../kernel/error-types.js';
import { createActiveProviderPolicy } from './active-provider.js';

const provider = (id: string, models: ModelInfo[]): IAIProvider => ({
  id,
  listModels: async () => models,
  startSession: () => {
    throw new Error('unused');
  },
  buildInteractiveCommand: () => {
    throw new Error('unused');
  },
});

function setup() {
  const reg = createProviderRegistry();
  reg.register(
    provider('copilot', [
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
    ]),
  );
  reg.register(provider('agency', [{ id: 'claude-sonnet', label: 'Claude' }]));
  return reg;
}

describe('provider-resolver', () => {
  it('uses the selected provider, denies inactive requests and rechecks after catalog awaits', async () => {
    const executionPolicy = createActiveProviderPolicy({
      enabledProviderIds: () => ['copilot', 'agency'], isEligible: () => true,
      initialProviderId: null, saveSelected: () => {},
    });
    const registry = setup();
    const resolver = createProviderResolver(registry, {
      executionPolicy, defaultProvider: 'copilot', defaultModelByProvider: {},
    });
    await expect(resolver.resolve({})).rejects.toThrow('Choose an active CLI');
    executionPolicy.select('agency');
    expect((await resolver.resolve({})).provider.id).toBe('agency');
    await expect(resolver.resolve({ providerId: 'copilot' })).rejects.toThrow('not the active');
    registry.get('agency').listModels = async () => {
      expect(() => executionPolicy.select('copilot')).toThrow('Stop all CLI work');
      return [{ id: 'model', label: 'Model' }];
    };
    expect((await resolver.resolve({ model: 'model' })).provider.id).toBe('agency');
    expect(executionPolicy.get().blockers).toEqual([]);
  });

  it('rechecks eligibility after awaiting a model catalog and releases failed resolution', async () => {
    let allowed = true;
    const executionPolicy = createActiveProviderPolicy({
      enabledProviderIds: () => ['copilot'], isEligible: () => allowed,
      initialProviderId: 'copilot', saveSelected: () => {},
    });
    const registry = setup();
    registry.get('copilot').listModels = async () => {
      allowed = false;
      return [{ id: 'model', label: 'Model' }];
    };
    const resolver = createProviderResolver(registry, {
      executionPolicy, defaultProvider: 'copilot', defaultModelByProvider: {},
    });
    await expect(resolver.resolve({ model: 'model' })).rejects.toThrow('Choose an active CLI');
    expect(executionPolicy.get().blockers).toEqual([]);
  });
  const config = {
    defaultProvider: 'copilot',
    defaultModelByProvider: { copilot: 'gpt-5.4' },
  };

  it('uses defaults when request is empty', async () => {
    const resolver = createProviderResolver(setup(), config);
    const sel = await resolver.resolve({});
    expect(sel.provider.id).toBe('copilot');
    expect(sel.model).toBe('gpt-5.4');
  });

  it('honors an explicit provider and model', async () => {
    const resolver = createProviderResolver(setup(), config);
    const sel = await resolver.resolve({ providerId: 'agency', model: 'claude-sonnet' });
    expect(sel.provider.id).toBe('agency');
    expect(sel.model).toBe('claude-sonnet');
  });

  it('falls back to auto when no default model is configured for the provider', async () => {
    const resolver = createProviderResolver(setup(), config);
    const sel = await resolver.resolve({ providerId: 'agency' });
    expect(sel.model).toBe('auto');
  });

  it('does not validate the catalog for auto', async () => {
    const resolver = createProviderResolver(setup(), config);
    const sel = await resolver.resolve({ providerId: 'copilot', model: 'auto' });
    expect(sel.model).toBe('auto');
  });

  it('rejects a model not in the provider catalog', async () => {
    const resolver = createProviderResolver(setup(), config);
    await expect(
      resolver.resolve({ providerId: 'copilot', model: 'ghost' }),
    ).rejects.toThrow(ValidationError);
  });
});
