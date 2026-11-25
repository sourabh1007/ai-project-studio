import { describe, expect, it } from 'vitest';
import { providerFeatures } from './provider-features.js';

describe('IDE feature availability', () => {
  it('renders configured future features from the backend without treating setup or checking as unsupported', () => {
    expect(providerFeatures({ installed: true, features: [
      { id: 'future', label: 'Future feature', status: 'setup-required', reason: 'Configure credentials' },
      { id: 'ready', label: 'Ready feature', status: 'available', reason: null },
    ] }).map(({ label, available, status }) => ({ label, available, status }))).toEqual([
      { label: 'Future feature', available: false, status: 'setup-required' },
      { label: 'Ready feature', available: true, status: 'available' },
    ]);
    expect(providerFeatures({ installed: true, automation: { supported: false, reason: 'Policy', integrationSupported: false } })
      .filter((feature) => feature.status === 'integration-required')).toHaveLength(5);
    expect(providerFeatures({ installed: false, automation: { supported: false, reason: 'Policy', integrationSupported: false } })
      .filter((feature) => feature.status === 'setup-required')).toHaveLength(6);
    expect(providerFeatures({ installed: true, features: [
      { id: 'legacy', label: 'Legacy integration', status: 'unsupported', reason: 'Integration missing' },
    ], automation: { supported: false, integrationSupported: false, reason: 'Integration missing' } })[0].status).toBe('integration-required');
    expect(providerFeatures({ installed: true, automation: { supported: false, reason: 'Checking', state: 'checking' } })
      .filter((feature) => feature.status === 'checking')).toHaveLength(5);
  });
  it('preserves non-AI features while reporting unavailable automated features', () => {
    const features = providerFeatures({ installed: true, automation: { supported: false, reason: 'Policy' } });
    expect(features.find((feature) => feature.label === 'Interactive CLI sessions')?.available).toBe(true);
    expect(features.filter((feature) => !feature.available).map((feature) => feature.label)).toEqual([
      'AI planning and summaries', 'AI Review Board', 'New Task and Bug Bash agents',
      'AI refinement and PR drafting', 'AI-powered automations',
    ]);
  });

  it('never infers automation support from installation or stale metadata alone', () => {
    expect(providerFeatures({ installed: true }).filter((feature) => feature.available)).toHaveLength(5);
    expect(providerFeatures({ installed: false, automation: { supported: true, reason: null } })
      .filter((feature) => feature.available)).toHaveLength(4);
    expect(providerFeatures({ installed: true, automation: { supported: true, reason: null } })
      .every((feature) => feature.available)).toBe(true);
  });
});
