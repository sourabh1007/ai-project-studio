import { describe, it, expect } from 'vitest';
import { createProviderResolver } from './provider-resolver.js';
import { createProviderRegistry } from './provider-registry.js';
import type { IAIProvider, ModelInfo } from './provider-contract.js';
import { ValidationError } from '../kernel/error-types.js';

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
