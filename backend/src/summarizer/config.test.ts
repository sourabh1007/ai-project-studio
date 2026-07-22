import { describe, it, expect } from 'vitest';
import {
  summarizerConfigSchema,
  summarizerDefaults,
  SUMMARIZER_NAMESPACE,
} from './config.js';

describe('summarizer config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(SUMMARIZER_NAMESPACE).toBe('summarizer');
    expect(() =>
      summarizerConfigSchema.parse(summarizerDefaults),
    ).not.toThrow();
  });

  it('rejects empty source kinds', () => {
    expect(() =>
      summarizerConfigSchema.parse({ ...summarizerDefaults, sourceKinds: [] }),
    ).toThrow();
  });

  it('rejects a non-positive output cap', () => {
    expect(() =>
      summarizerConfigSchema.parse({
        ...summarizerDefaults,
        maxOutputCharsPerSession: 0,
      }),
    ).toThrow();
  });
});
