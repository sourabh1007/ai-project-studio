import { expect, it } from 'vitest';
import { providerFeaturesConfigSchema, providerFeaturesDefaults } from './config.js';
import { resolveProviderFeatures } from './provider-features.js';

it('distinguishes Studio integration from native support, installation, checking and configured readiness', () => {
  const config = providerFeaturesConfigSchema.parse(providerFeaturesDefaults);
  expect(resolveProviderFeatures(config, true, { supported: true, reason: null }).every((feature) => feature.status === 'available')).toBe(true);
  expect(resolveProviderFeatures(config, false, { supported: true, reason: null }).filter((feature) => feature.status === 'setup-required')).toHaveLength(6);
  expect(resolveProviderFeatures(config, true, { supported: false, state: 'checking', reason: 'Checking' }).filter((feature) => feature.status === 'checking')).toHaveLength(5);
  expect(resolveProviderFeatures(config, true, { supported: false, state: 'blocked', reason: 'Credentials missing' }).filter((feature) => feature.status === 'setup-required')).toHaveLength(5);
  const integration = { supported: false, integrationSupported: false, reason: 'Studio integration needs verified native inventory' };
  expect(resolveProviderFeatures(config, true, integration).filter((feature) => feature.status === 'integration-required')).toHaveLength(5);
  expect(resolveProviderFeatures(config, false, integration).filter((feature) => feature.status === 'setup-required')).toHaveLength(6);
  expect(resolveProviderFeatures(config, true, integration).some((feature) => feature.status === 'unsupported')).toBe(false);
});

it('supports configurable future features without per-provider UI hardcoding or readiness overrides', () => {
  const config = providerFeaturesConfigSchema.parse({ features: [
    { id: 'future-analysis', label: 'Future analysis', requires: ['installed-cli', 'automation'] },
    { id: 'manual-view', label: 'Manual view', requires: [] },
  ] });
  expect(resolveProviderFeatures(config, true, { supported: false, reason: 'Native policy' })).toEqual([
    { id: 'future-analysis', label: 'Future analysis', status: 'setup-required', reason: 'Native policy' },
    { id: 'manual-view', label: 'Manual view', status: 'available', reason: null },
  ]);
  expect(providerFeaturesConfigSchema.safeParse({ features: [config.features[0], config.features[0]] }).success).toBe(false);
  expect(providerFeaturesConfigSchema.safeParse({ features: [{ id: 'bad', label: 'Bad', requires: ['invented-permission'] }] }).success).toBe(false);
});
