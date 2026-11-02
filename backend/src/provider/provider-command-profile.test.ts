import { describe, expect, it } from 'vitest';
import { providerCommandProfileSchema, copilotCommandProfile } from './provider-command-profile.js';
import { copilotConfigSchema, copilotDefaults } from './copilot-adapter/config.js';
import { agencyConfigSchema, agencyDefaults } from './agency-adapter/config.js';

describe('provider command profiles', () => {
  it('preserves configurable commands without assuming internal authentication commands', () => {
    expect(copilotConfigSchema.parse(copilotDefaults).commandProfile).toEqual(copilotCommandProfile);
    expect(agencyConfigSchema.parse(agencyDefaults).commandProfile?.loginCommand).toBeNull();
    expect(copilotDefaults.commandProfile?.liveReloadCommand).toBe('/restart');
    expect(agencyDefaults.commandProfile?.liveReloadCommand).toBe('/restart');
    const configured = { usageCommand: '/account-usage', versionArgs: ['version'], loginCommand: '/auth' };
    expect(providerCommandProfileSchema.parse(configured)).toEqual(configured);
  });

  it.each(['', '/usage\rprompt', '/usage\nprompt'])('rejects invalid interactive usage commands: %j', (usageCommand) => {
    expect(providerCommandProfileSchema.safeParse({ ...copilotCommandProfile, usageCommand }).success).toBe(false);
  });
});
