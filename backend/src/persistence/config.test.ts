import { describe, it, expect } from 'vitest';
import {
  persistenceConfigSchema,
  persistenceDefaults,
  PERSISTENCE_NAMESPACE,
} from './config.js';

describe('persistence config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(PERSISTENCE_NAMESPACE).toBe('persistence');
    expect(() => persistenceConfigSchema.parse(persistenceDefaults)).not.toThrow();
  });

  it('rejects an empty database path', () => {
    expect(() => persistenceConfigSchema.parse({ databasePath: '' })).toThrow();
  });
});
