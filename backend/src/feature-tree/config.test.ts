import { describe, it, expect } from 'vitest';
import {
  featureTreeConfigSchema,
  featureTreeDefaults,
  FEATURE_TREE_NAMESPACE,
} from './config.js';

describe('feature-tree config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(FEATURE_TREE_NAMESPACE).toBe('featureTree');
    expect(() => featureTreeConfigSchema.parse(featureTreeDefaults)).not.toThrow();
  });

  it('rejects a blank default subcategory name', () => {
    expect(() =>
      featureTreeConfigSchema.parse({ defaultSubcategoryName: '' }),
    ).toThrow();
  });
});
