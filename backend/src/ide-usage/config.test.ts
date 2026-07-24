import { describe, it, expect } from 'vitest';
import {
  ideUsageConfigSchema,
  ideUsageDefaults,
  IDE_USAGE_NAMESPACE,
} from './config.js';

describe('ide-usage config', () => {
  it('exposes a namespace and valid defaults counting meta sessions', () => {
    expect(IDE_USAGE_NAMESPACE).toBe('ideUsage');
    expect(ideUsageDefaults.metaKinds).toEqual(['meta']);
    expect(() => ideUsageConfigSchema.parse(ideUsageDefaults)).not.toThrow();
  });

  it('rejects an empty set of meta kinds', () => {
    expect(() =>
      ideUsageConfigSchema.parse({ ...ideUsageDefaults, metaKinds: [] }),
    ).toThrow();
  });

  it('rejects an unknown session kind', () => {
    expect(() =>
      ideUsageConfigSchema.parse({ metaKinds: ['other'] }),
    ).toThrow();
  });
});
