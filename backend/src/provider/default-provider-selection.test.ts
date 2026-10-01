import { describe, it, expect } from 'vitest';
import {
  selectDefaultProvider,
  COPILOT_PROVIDER_ID,
  AGENCY_PROVIDER_ID,
} from './default-provider-selection.js';

const both = [COPILOT_PROVIDER_ID, AGENCY_PROVIDER_ID];

describe('selectDefaultProvider', () => {
  it('throws when no providers are enabled', () => {
    expect(() =>
      selectDefaultProvider({ microsoftNetwork: false, enabled: [], installed: new Set() }),
    ).toThrow(/at least one enabled provider/);
  });

  it('honours a valid user override regardless of network', () => {
    expect(
      selectDefaultProvider({
        microsoftNetwork: true,
        enabled: both,
        installed: new Set(both),
        override: COPILOT_PROVIDER_ID,
      }),
    ).toBe(COPILOT_PROVIDER_ID);
  });

  it('ignores an override that names a non-enabled provider', () => {
    expect(
      selectDefaultProvider({
        microsoftNetwork: false,
        enabled: [COPILOT_PROVIDER_ID],
        installed: new Set([COPILOT_PROVIDER_ID]),
        override: AGENCY_PROVIDER_ID,
      }),
    ).toBe(COPILOT_PROVIDER_ID);
  });

  it('prefers Agency (installed) on the Microsoft network', () => {
    expect(
      selectDefaultProvider({
        microsoftNetwork: true,
        enabled: both,
        installed: new Set(both),
      }),
    ).toBe(AGENCY_PROVIDER_ID);
  });

  it('prefers Copilot (installed) off the Microsoft network', () => {
    expect(
      selectDefaultProvider({
        microsoftNetwork: false,
        enabled: both,
        installed: new Set(both),
      }),
    ).toBe(COPILOT_PROVIDER_ID);
  });

  it('falls back to the other installed provider when the preferred is missing', () => {
    expect(
      selectDefaultProvider({
        microsoftNetwork: true,
        enabled: both,
        installed: new Set([COPILOT_PROVIDER_ID]),
      }),
    ).toBe(COPILOT_PROVIDER_ID);
  });

  it('returns the network-preferred provider when neither is installed yet', () => {
    expect(
      selectDefaultProvider({
        microsoftNetwork: true,
        enabled: both,
        installed: new Set(),
      }),
    ).toBe(AGENCY_PROVIDER_ID);
    expect(
      selectDefaultProvider({
        microsoftNetwork: false,
        enabled: both,
        installed: new Set(),
      }),
    ).toBe(COPILOT_PROVIDER_ID);
  });

  it('falls through to the first enabled provider for unknown ids', () => {
    expect(
      selectDefaultProvider({
        microsoftNetwork: false,
        enabled: ['custom-llm'],
        installed: new Set(),
      }),
    ).toBe('custom-llm');
  });
});
