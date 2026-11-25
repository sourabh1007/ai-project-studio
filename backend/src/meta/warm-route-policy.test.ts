import { describe, it, expect } from 'vitest';
import { agencyDefaults } from '../provider/agency-adapter/config.js';
import { copilotDefaults } from '../provider/copilot-adapter/config.js';
import { metaDefaults } from './config.js';
import {
  createConfiguredWarmRoutePolicy,
  createWarmRoutePolicy,
  resolveWarmProviderIdentity,
  warmPoolAvailability,
} from './warm-route-policy.js';
import type { MetaRequest } from './meta-runner.js';

const baseRequest: MetaRequest = {
  featureId: 'f1',
  prompt: 'hi',
};

describe('warmPoolAvailability', () => {
  const base = { enabled: true, providerId: 'copilot', installed: true, selectionRequired: false,
    transport: 'acp' as const, warmProviderId: 'copilot', running: false, starting: false, failed: false };

  it.each([
    [{ selectionRequired: true }, 'unavailable', 'Select a CLI'],
    [{ installed: false }, 'unavailable', 'not installed'],
    [{ providerId: 'agency', transport: undefined }, 'unavailable', 'on demand'],
    [{ warmProviderId: null }, 'unavailable', 'does not match'],
    [{ enabled: false }, 'disabled', 'turned off'],
    [{ running: true }, 'running', 'is running'],
    [{ failed: true }, 'failed', 'startup failed'],
    [{ starting: true }, 'starting', 'Starting'],
    [{}, 'unavailable', 'No warm pool'],
  ] as const)('reports actual availability without changing provider or routing (%s)', (patch, state, message) => {
    const input = { ...base, ...patch };
    const result = warmPoolAvailability(input);
    expect(result).toMatchObject({ state, providerId: input.providerId });
    expect(result.message).toContain(message);
  });
});

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
    // An explicit provider that matches the warm identity stays warm.
    expect(supportsWarm({ ...baseRequest, providerId: 'copilot' })).toBe(true);
  });

  it('fails closed when the warm provider identity is unknown', () => {
    const supportsWarm = createWarmRoutePolicy({
      settings: { get: () => ({ providerId: 'copilot', model: 'auto' }) },
      warmProviderId: null,
    });
    expect(supportsWarm(baseRequest)).toBe(false);
  });

  it('rejects requests that require a concrete model, tools-off, attachments, or a non-internal scope', () => {
    const concreteModel = createWarmRoutePolicy({
      settings: { get: () => ({ providerId: 'copilot', model: 'gpt-5' }) },
      warmProviderId: 'copilot',
    });
    expect(concreteModel({ ...baseRequest })).toBe(false);
    const autoModel = createWarmRoutePolicy({
      settings: { get: () => ({ providerId: 'copilot', model: 'auto' }) },
      warmProviderId: 'copilot',
    });
    expect(autoModel({ ...baseRequest, model: 'gpt-5' })).toBe(false);
    expect(autoModel({ ...baseRequest, noTools: true })).toBe(false);
    expect(autoModel({ ...baseRequest, attachments: ['C:\\repo\\a.txt'] })).toBe(false);
    expect(autoModel({ ...baseRequest, scope: 'feature' })).toBe(false);
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

  it('does not route work through a different provider than the selected one', () => {
    const supportsWarm = createWarmRoutePolicy({
      settings: { get: () => ({ providerId: 'agency', model: 'auto' }) },
      warmProviderId: 'copilot',
    });
    expect(supportsWarm(baseRequest)).toBe(false);
    expect(supportsWarm({ ...baseRequest, providerId: 'agency' })).toBe(false);
    const selectedCopilot = createWarmRoutePolicy({
      settings: { get: () => ({ providerId: 'copilot', model: 'auto' }) },
      warmProviderId: 'copilot',
    });
    expect(selectedCopilot({ ...baseRequest, providerId: 'claude' })).toBe(false);
  });
});

describe('createConfiguredWarmRoutePolicy', () => {
  it('does not route an Agency default through a Copilot warm pool', () => {
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
    expect(supportsWarm(baseRequest)).toBe(metaDefaults.providerId === 'copilot');
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
