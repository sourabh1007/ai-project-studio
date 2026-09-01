import { describe, it, expect } from 'vitest';
import { providerLabel, modelLabel, metaModelLabel } from './meta-model.js';

describe('meta-model labels', () => {
  it('maps known provider ids to friendly names', () => {
    expect(providerLabel('agency')).toBe('Agency');
    expect(providerLabel('copilot')).toBe('Copilot');
  });

  it('capitalizes unknown provider ids', () => {
    expect(providerLabel('custom')).toBe('Custom');
  });

  it('returns an empty provider id unchanged', () => {
    expect(providerLabel('')).toBe('');
  });

  it('renders auto model as Auto and passes through others', () => {
    expect(modelLabel('auto')).toBe('Auto');
    expect(modelLabel('gpt-5')).toBe('gpt-5');
  });

  it('builds a compact provider · model label', () => {
    expect(metaModelLabel({ providerId: 'agency', model: 'auto' })).toBe(
      'Agency · Auto',
    );
    expect(metaModelLabel({ providerId: 'copilot', model: 'gpt-5' })).toBe(
      'Copilot · gpt-5',
    );
  });
});
