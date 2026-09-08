import { describe, expect, it } from 'vitest';
import { META_OPERATIONS_NAMESPACE, metaOperationsConfigSchema, metaOperationsDefaults } from './meta-operations-config.js';

describe('meta operation configuration', () => {
  it('registers bounded valid defaults', () => {
    expect(META_OPERATIONS_NAMESPACE).toBe('metaOperations');
    expect(metaOperationsConfigSchema.parse(metaOperationsDefaults)).toEqual(metaOperationsDefaults);
  });
  it.each([{ defaultPageSize: 0 }, { maxPageSize: 1001 }, { recoveryPageSize: 1.5 }, { defaultPageSize: 101 }])('rejects invalid work limits %j', (change) => {
    expect(() => metaOperationsConfigSchema.parse({ ...metaOperationsDefaults, ...change })).toThrow();
  });
});
