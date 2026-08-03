import { describe, it, expect } from 'vitest';
import {
  overridesToConfig,
  type ConfigOverrideRecord,
} from './config-override-store.js';

function record(
  namespace: string,
  data: Record<string, unknown>,
): ConfigOverrideRecord {
  return { namespace, data, updatedAt: '2026-01-01T00:00:00.000Z' };
}

describe('overridesToConfig', () => {
  it('collapses records into a namespace-keyed object', () => {
    const out = overridesToConfig([
      record('alpha', { n: 1 }),
      record('beta', { s: 'x' }),
    ]);
    expect(out).toEqual({ alpha: { n: 1 }, beta: { s: 'x' } });
  });

  it('returns an empty object for no records', () => {
    expect(overridesToConfig([])).toEqual({});
  });
});
