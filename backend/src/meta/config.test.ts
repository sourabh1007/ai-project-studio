import { describe, it, expect } from 'vitest';
import { metaConfigSchema, metaDefaults, META_NAMESPACE } from './config.js';

describe('meta config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(META_NAMESPACE).toBe('meta');
    expect(() => metaConfigSchema.parse(metaDefaults)).not.toThrow();
  });

  it('rejects an empty provider id', () => {
    expect(() =>
      metaConfigSchema.parse({ ...metaDefaults, providerId: '' }),
    ).toThrow();
  });

  it('rejects an empty set of response keys', () => {
    expect(() =>
      metaConfigSchema.parse({ ...metaDefaults, responseTextKeys: [] }),
    ).toThrow();
  });

  it('carries warm-pool defaults and rejects a non-positive size', () => {
    expect(metaDefaults.warmPool.enabled).toBe(true);
    expect(metaDefaults.warmPool.pools.length).toBeGreaterThan(0);
    expect(metaDefaults.warmPool.pools[0].size).toBeGreaterThan(0);
    expect(() =>
      metaConfigSchema.parse({
        ...metaDefaults,
        warmPool: {
          ...metaDefaults.warmPool,
          pools: [{ purpose: 'general', size: 0 }],
        },
      }),
    ).toThrow();
  });

  it('rejects duplicate warm-pool purposes', () => {
    expect(() =>
      metaConfigSchema.parse({
        ...metaDefaults,
        warmPool: {
          ...metaDefaults.warmPool,
          pools: [
            { purpose: 'general', size: 2 },
            { purpose: 'general', size: 3 },
          ],
        },
      }),
    ).toThrow();
  });

  it('requires a general warm pool', () => {
    expect(() =>
      metaConfigSchema.parse({
        ...metaDefaults,
        warmPool: {
          ...metaDefaults.warmPool,
          pools: [{ purpose: 'review', size: 2 }],
        },
      }),
    ).toThrow();
  });
});
