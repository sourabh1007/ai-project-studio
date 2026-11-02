import { z } from 'zod';

export const PROVIDER_SELECTION_NAMESPACE = 'providerSelection';
export const providerSelectionConfigSchema = z.object({
  providerId: z.string().trim().min(1).nullable(),
  allowInternalAgency: z.boolean().default(false),
});
export type ProviderSelectionConfig = z.infer<typeof providerSelectionConfigSchema>;
export const providerSelectionDefaults: ProviderSelectionConfig = { providerId: null, allowInternalAgency: false };
