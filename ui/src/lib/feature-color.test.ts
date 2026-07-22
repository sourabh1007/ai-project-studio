import { describe, expect, it } from 'vitest';
import {
  FEATURE_COLOR_COUNT,
  featureColor,
  featureColorIndex,
} from './feature-color.js';

describe('feature-color', () => {
  it('maps an id to a 1-based slot within the palette range', () => {
    for (const id of ['a', 'feature-1', 'x'.repeat(50), '']) {
      const index = featureColorIndex(id);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(FEATURE_COLOR_COUNT);
    }
  });

  it('is deterministic for the same id', () => {
    expect(featureColorIndex('feature-42')).toBe(featureColorIndex('feature-42'));
    expect(featureColor('feature-42')).toBe(featureColor('feature-42'));
  });

  it('distributes different ids across more than one slot', () => {
    const slots = new Set(
      Array.from({ length: 40 }, (_, i) => featureColorIndex(`feature-${i}`)),
    );
    expect(slots.size).toBeGreaterThan(1);
  });

  it('resolves to a CSS custom-property reference', () => {
    expect(featureColor('feature-1')).toMatch(
      /^var\(--feature-color-[1-8]\)$/,
    );
  });
});
