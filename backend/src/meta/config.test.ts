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
});
