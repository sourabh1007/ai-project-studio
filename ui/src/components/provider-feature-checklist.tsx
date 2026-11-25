import type { ReactNode } from 'react';
import { providerFeatures, type ProviderFeatureSource } from '../lib/provider-features.js';
import { CheckIcon, CloseIcon, WarningIcon, ClockIcon } from './icons.js';

export function ProviderFeatureChecklist({ provider, children, hideHelp = false }: {
  provider: ProviderFeatureSource;
  children?: ReactNode;
  hideHelp?: boolean;
}) {
  const features = providerFeatures(provider);
  return <details className="provider-feature-checklist">
    <summary>IDE feature readiness</summary>
    {!hideHelp && <p className="provider-feature-hint">Readiness in Studio, not a list of the CLI’s native limitations.</p>}
    <ul>
      {features.map((feature) => <li key={feature.id}>
        <span className="provider-feature-icon" role="img" aria-label={feature.available ? 'Available' : feature.status === 'unsupported' ? 'Unavailable' : feature.status === 'checking' ? 'Checking' : feature.status === 'integration-required' ? 'Studio integration required' : 'Setup required'}
          title={feature.reason ?? undefined}
          style={{ color: feature.available ? 'var(--success)' : feature.status === 'unsupported' ? 'var(--danger)' : 'var(--warning)' }}>
          {feature.available ? <CheckIcon size={14} /> : feature.status === 'unsupported' ? <CloseIcon size={14} /> : feature.status === 'checking' ? <ClockIcon size={14} /> : <WarningIcon size={14} />}
        </span>
        <span className="provider-feature-label">
          {feature.label}
          {feature.status === 'setup-required' && <small>Needs setup</small>}
          {feature.status === 'checking' && <small>Checking</small>}
          {feature.status === 'integration-required' && <small>Studio integration needed</small>}
          {feature.status === 'unsupported' && <small>Unavailable</small>}
        </span>
      </li>)}
    </ul>
    {!hideHelp && (provider.automation?.reason || children) && <details>
      <summary>Troubleshooting</summary>
      {provider.automation?.reason && <p className="field-hint">{provider.automation.reason}</p>}
      {children}
    </details>}
  </details>;
}
