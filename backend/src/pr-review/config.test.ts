import { describe, expect, it } from 'vitest';
import {
  PR_REVIEW_NAMESPACE,
  prReviewConfigSchema,
  prReviewDefaults,
} from './config.js';

describe('pr-review config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(PR_REVIEW_NAMESPACE).toBe('prReview');
    expect(() => prReviewConfigSchema.parse(prReviewDefaults)).not.toThrow();
  });

  it('rejects a non-positive context budget', () => {
    expect(() =>
      prReviewConfigSchema.parse({ ...prReviewDefaults, maxContextChars: 0 }),
    ).toThrow();
  });

  it('rejects a non-positive patch budget', () => {
    expect(() =>
      prReviewConfigSchema.parse({ ...prReviewDefaults, maxPatchChars: -1 }),
    ).toThrow();
  });

  it('rejects a non-positive step timeout', () => {
    expect(() =>
      prReviewConfigSchema.parse({ ...prReviewDefaults, stepTimeoutMs: 0 }),
    ).toThrow();
  });
});
