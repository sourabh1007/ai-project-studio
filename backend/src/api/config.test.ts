import { describe, it, expect } from 'vitest';
import { apiConfigSchema, apiDefaults, API_NAMESPACE } from './config.js';

describe('api config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(API_NAMESPACE).toBe('api');
    expect(() => apiConfigSchema.parse(apiDefaults)).not.toThrow();
  });

  it('rejects an out-of-range port', () => {
    expect(() =>
      apiConfigSchema.parse({ ...apiDefaults, port: 70000 }),
    ).toThrow();
  });
});
