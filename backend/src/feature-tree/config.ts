import { z } from 'zod';

/**
 * Configuration for the feature-tree module. Keeps the user-facing fallback
 * name out of the code so it stays configurable rather than hardcoded.
 */
export const FEATURE_TREE_NAMESPACE = 'featureTree';

export const featureTreeConfigSchema = z.object({
  /** Name applied to a group created with a blank/whitespace-only name. */
  defaultSubcategoryName: z.string().min(1),
});

export type FeatureTreeConfig = z.infer<typeof featureTreeConfigSchema>;

export const featureTreeDefaults: FeatureTreeConfig = {
  defaultSubcategoryName: 'New group',
};
