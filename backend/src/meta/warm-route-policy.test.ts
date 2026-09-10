import { describe, it, expect } from 'vitest';
import { agencyDefaults } from '../provider/agency-adapter/config.js';
import { copilotDefaults } from '../provider/copilot-adapter/config.js';
import { metaDefaults } from './config.js';
import {
  createConfiguredWarmRoutePolicy,
  createWarmRoutePolicy,
  resolveWarmProviderIdentity,
} from './warm-route-policy.js';
import type { MetaRequest } from './meta-runner.js';

const baseRequest: MetaRequest = {
  featureId: 'f1',
  prompt: 'hi',
};

describe('resolveWarmProviderIdentity', () => {
  it('identifies the warm ACP executable as Copilot only when the executable matches that provider uniquely', () => {
    expect(
      resolveWarmProviderIdentity({
        warmExecutable: 'copilot',
        copilotExecutable: 'copilot',
        agencyExecutable: 'agency',
      }),
    ).toBe('copilot');
    expect(
      resolveWarmProviderIdentity({
        warmExecutable: 'agency',
        copilotExecutable: 'copilot',
        agencyExecutable: 'agency',
      }),
    ).toBeNull();
    expect(
      resolveWarmProviderIdentity({
        warmExecutable: 'copilot',
        copilotExecutable: 'copilot',
        agencyExecutable: 'copilot',
      }),
    ).toBeNull();
  });
});

describe('createWarmRoutePolicy', () => {
  it('accepts only internal requests on the warm provider default model', () => {
    const supportsWarm = createWarmRoutePolicy({
      settings: { get: () => ({ providerId: 'copilot', model: 'auto' }) },
      warmProviderId: 'copilot',
    });
    expect(supportsWarm(baseRequest)).toBe(true);
  });

  it('fails closed when the warm provider identity is unknown', () => {
    const supportsWarm = createWarmRoutePolicy({
      settings: { get: () => ({ providerId: 'copilot', model: 'auto' }) },
      warmProviderId: null,
    });
    expect(supportsWarm(baseRequest)).toBe(false);
  });

  it('rejects requests that require a concrete model, tools-off, attachments, or another provider', () => {
    const supportsWarm = createWarmRoutePolicy({
      settings: { get: () => ({ providerId: 'copilot', model: 'gpt-5' }) },
      warmProviderId: 'copilot',
    });
    expect(supportsWarm({ ...baseRequest })).toBe(false);
    expect(supportsWarm({ ...baseRequest, model: 'gpt-5' })).toBe(false);
    expect(supportsWarm({ ...baseRequest, providerId: 'other' })).toBe(false);
    expect(supportsWarm({ ...baseRequest, noTools: true })).toBe(false);
    expect(supportsWarm({ ...baseRequest, attachments: ['C:\\repo\\a.txt'] })).toBe(false);
    expect(supportsWarm({ ...baseRequest, scope: 'feature' })).toBe(false);
  });

  it('serves a tool-less request warm when the caller marked tools optional', () => {
    const supportsWarm = createWarmRoutePolicy({
      settings: { get: () => ({ providerId: 'copilot', model: 'auto' }) },
      warmProviderId: 'copilot',
    });
    expect(supportsWarm({ ...baseRequest, noTools: true })).toBe(false);
    expect(
      supportsWarm({ ...baseRequest, noTools: true, toolsOptional: true }),
    ).toBe(true);
    // Tools being optional does not excuse a constraint warm cannot meet.
    expect(
      supportsWarm({
        ...baseRequest,
        noTools: true,
        toolsOptional: true,
        attachments: ['C:\\repo\\a.txt'],
      }),
    ).toBe(false);
  });
});

describe('createConfiguredWarmRoutePolicy', () => {
  it('uses production defaults to route agency-default metasessions cold because warm ACP actually launches Copilot', () => {
    const supportsWarm = createConfiguredWarmRoutePolicy({
      settings: {
        get: () => ({
          providerId: metaDefaults.providerId,
          model: metaDefaults.model,
        }),
      },
      metaConfig: metaDefaults,
      copilotConfig: copilotDefaults,
      agencyConfig: agencyDefaults,
    });
    expect(supportsWarm(baseRequest)).toBe(false);
  });

  it('allows warm routing only after the live settings match the resolved warm executable identity', () => {
    const supportsWarm = createConfiguredWarmRoutePolicy({
      settings: { get: () => ({ providerId: 'copilot', model: 'auto' }) },
      metaConfig: metaDefaults,
      copilotConfig: copilotDefaults,
      agencyConfig: agencyDefaults,
    });
    expect(supportsWarm(baseRequest)).toBe(true);
  });

  it('fails closed when the configured warm executable is not the known Copilot executable', () => {
    const supportsWarm = createConfiguredWarmRoutePolicy({
      settings: { get: () => ({ providerId: 'copilot', model: 'auto' }) },
      metaConfig: {
        ...metaDefaults,
        warmPool: { ...metaDefaults.warmPool, executable: 'C:\\tools\\custom-copilot.exe' },
      },
      copilotConfig: copilotDefaults,
      agencyConfig: agencyDefaults,
    });
    expect(supportsWarm(baseRequest)).toBe(false);
  });
});
