import type { ProviderFeaturesConfig } from './config.js';

export interface ProviderFeature {
  id: string;
  label: string;
  status: 'available' | 'setup-required' | 'checking' | 'integration-required' | 'unsupported';
  reason: string | null;
}

export interface AutomationReadiness {
  supported: boolean;
  integrationSupported?: boolean;
  state?: 'checking' | 'ready' | 'blocked' | 'unsupported';
  reason: string | null;
}

export function resolveProviderFeatures(
  config: ProviderFeaturesConfig,
  installed: boolean,
  automation: AutomationReadiness,
): ProviderFeature[] {
  return config.features.map(({ id, label, requires }) => {
    if (requires.length > 0 && !installed) {
      return { id, label, status: 'setup-required', reason: 'Install this CLI to use this feature.' };
    }
    if (requires.includes('automation') && automation.integrationSupported === false) {
      return { id, label, status: 'integration-required', reason: automation.reason };
    }
    if (requires.includes('automation') && !automation.supported) {
      return { id, label, status: automation.state === 'checking' ? 'checking' : 'setup-required', reason: automation.reason };
    }
    return { id, label, status: 'available', reason: null };
  });
}
