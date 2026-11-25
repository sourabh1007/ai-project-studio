import type { ProviderSelectionInfo } from './api.js';

export type ProviderFeatureSource = Pick<ProviderSelectionInfo['providers'][number], 'installed' | 'automation' | 'features'>;
export const UNAVAILABLE_FEATURES_KEY = 'cw-show-unavailable-features';
export const UNAVAILABLE_FEATURES_CHANGED = 'cw-unavailable-features-changed';

export function providerFeatures(provider: ProviderFeatureSource) {
  if (provider.features) return provider.features.map((feature) => ({
    ...feature,
    status: feature.status === 'unsupported' && provider.automation?.integrationSupported === false
      ? 'integration-required' as const : feature.status,
    available: feature.status === 'available',
  }));
  const automated = provider.installed === true && provider.automation?.supported === true;
  const rows = [
    { label: 'Workspace and repositories', available: true },
    { label: 'PR browsing and manual comments', available: true },
    { label: 'Session history and usage dashboards', available: true },
    { label: 'Skills and MCP settings', available: true },
    { label: 'Interactive CLI sessions', available: provider.installed === true },
    { label: 'AI planning and summaries', available: automated },
    { label: 'AI Review Board', available: automated },
    { label: 'New Task and Bug Bash agents', available: automated },
    { label: 'AI refinement and PR drafting', available: automated },
    { label: 'AI-powered automations', available: automated },
  ];
  return rows.map((feature, index) => ({
    ...feature,
    id: `legacy-${index}`,
    status: feature.available ? 'available' as const
      : provider.installed && provider.automation?.integrationSupported === false && feature.label !== 'Interactive CLI sessions'
        ? 'integration-required' as const
        : provider.installed && provider.automation?.state === 'checking' ? 'checking' as const : 'setup-required' as const,
    reason: feature.available ? null : provider.automation?.reason ?? 'Complete CLI setup and refresh readiness.',
  }));
}
