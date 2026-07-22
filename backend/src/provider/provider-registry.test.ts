import { describe, it, expect } from 'vitest';
import { createProviderRegistry } from './provider-registry.js';
import type { IAIProvider } from './provider-contract.js';
import { NotFoundError, ConflictError } from '../kernel/error-types.js';

const fakeProvider = (id: string): IAIProvider => ({
  id,
  listModels: async () => [],
  startSession: () => {
    throw new Error('not used');
  },
  buildInteractiveCommand: () => {
    throw new Error('not used');
  },
});

describe('provider-registry', () => {
  it('registers and retrieves providers', () => {
    const reg = createProviderRegistry();
    const p = fakeProvider('copilot');
    reg.register(p);
    expect(reg.get('copilot')).toBe(p);
    expect(reg.has('copilot')).toBe(true);
    expect(reg.ids()).toEqual(['copilot']);
    expect(reg.list()).toEqual([p]);
  });

  it('throws on duplicate registration', () => {
    const reg = createProviderRegistry();
    reg.register(fakeProvider('copilot'));
    expect(() => reg.register(fakeProvider('copilot'))).toThrow(ConflictError);
  });

  it('throws NotFoundError for unknown provider', () => {
    const reg = createProviderRegistry();
    expect(() => reg.get('ghost')).toThrow(NotFoundError);
    expect(reg.has('ghost')).toBe(false);
  });
});
