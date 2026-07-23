import { describe, it, expect } from 'vitest';
import {
  sessionImportConfigSchema,
  sessionImportDefaults,
  SESSION_IMPORT_NAMESPACE,
} from './config.js';

describe('session-import config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(SESSION_IMPORT_NAMESPACE).toBe('sessionImport');
    expect(() =>
      sessionImportConfigSchema.parse(sessionImportDefaults),
    ).not.toThrow();
  });

  it('rejects a non-positive session cap', () => {
    expect(() =>
      sessionImportConfigSchema.parse({ ...sessionImportDefaults, maxSessions: 0 }),
    ).toThrow();
  });

  it('rejects a non-positive title cap', () => {
    expect(() =>
      sessionImportConfigSchema.parse({ ...sessionImportDefaults, maxTitleChars: 0 }),
    ).toThrow();
  });

  it('rejects an empty placeholder', () => {
    expect(() =>
      sessionImportConfigSchema.parse({
        ...sessionImportDefaults,
        emptyTitlePlaceholder: '',
      }),
    ).toThrow();
  });
});
