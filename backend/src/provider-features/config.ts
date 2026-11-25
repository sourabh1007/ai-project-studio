import { z } from 'zod';

export const PROVIDER_FEATURES_NAMESPACE = 'providerFeatures';
export const providerFeaturesConfigSchema = z.object({
  features: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/).max(80),
    label: z.string().trim().min(1).max(160),
    requires: z.array(z.enum(['installed-cli', 'automation'])).max(2),
  })).min(1).max(100).refine(
    (features) => new Set(features.map((feature) => feature.id)).size === features.length,
    'Feature identifiers must be unique',
  ).describe('IDE feature catalogue. Add a feature with its real execution requirements; this never overrides provider safety checks.'),
});

export type ProviderFeaturesConfig = z.infer<typeof providerFeaturesConfigSchema>;
export const providerFeaturesDefaults: ProviderFeaturesConfig = {
  features: [
    { id: 'workspace', label: 'Workspace and repositories', requires: [] },
    { id: 'pr-browsing', label: 'PR browsing and manual comments', requires: [] },
    { id: 'history', label: 'Session history and usage dashboards', requires: [] },
    { id: 'configuration', label: 'Skills and MCP settings', requires: [] },
    { id: 'interactive', label: 'Interactive CLI sessions', requires: ['installed-cli'] },
    { id: 'planning', label: 'AI planning and summaries', requires: ['automation'] },
    { id: 'review', label: 'AI Review Board', requires: ['automation'] },
    { id: 'agents', label: 'New Task and Bug Bash agents', requires: ['automation'] },
    { id: 'refinement', label: 'AI refinement and PR drafting', requires: ['automation'] },
    { id: 'automations', label: 'AI-powered automations', requires: ['automation'] },
  ],
};
