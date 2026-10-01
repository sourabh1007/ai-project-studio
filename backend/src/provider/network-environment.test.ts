import { describe, it, expect } from 'vitest';
import {
  explicitNetworkOverride,
  envIndicatesMicrosoftNetwork,
  resolveMicrosoftNetwork,
  MS_NETWORK_OVERRIDE_VARS,
} from './network-environment.js';

describe('explicitNetworkOverride', () => {
  it('returns null when no override var is set', () => {
    expect(explicitNetworkOverride({})).toBeNull();
    expect(explicitNetworkOverride({ CW_MS_NETWORK: '   ' })).toBeNull();
  });

  it.each(['1', 'true', 'YES', 'On'])('treats %s as true', (value) => {
    expect(explicitNetworkOverride({ CW_MS_NETWORK: value })).toBe(true);
  });

  it.each(['0', 'false', 'NO', 'Off'])('treats %s as false', (value) => {
    expect(explicitNetworkOverride({ CW_MS_NETWORK: value })).toBe(false);
  });

  it('returns null for an unrecognised value', () => {
    expect(explicitNetworkOverride({ CW_MS_NETWORK: 'maybe' })).toBeNull();
  });

  it('prefers the first override var in order', () => {
    expect(MS_NETWORK_OVERRIDE_VARS[0]).toBe('AI_STUDIO_MS_NETWORK');
    expect(
      explicitNetworkOverride({ AI_STUDIO_MS_NETWORK: 'true', CW_MS_NETWORK: 'false' }),
    ).toBe(true);
  });

  it('falls through an empty earlier var to a later one', () => {
    expect(
      explicitNetworkOverride({ AI_STUDIO_MS_NETWORK: '', CW_MS_NETWORK: 'true' }),
    ).toBe(true);
  });
});

describe('envIndicatesMicrosoftNetwork', () => {
  it('matches a Microsoft corp DNS domain', () => {
    expect(
      envIndicatesMicrosoftNetwork({ USERDNSDOMAIN: 'REDMOND.CORP.MICROSOFT.COM' }),
    ).toBe(true);
  });

  it('matches USERDOMAIN and LOGONSERVER markers', () => {
    expect(envIndicatesMicrosoftNetwork({ USERDOMAIN: 'NTDEV' })).toBe(true);
    expect(envIndicatesMicrosoftNetwork({ LOGONSERVER: '\\\\CORP-DC01' })).toBe(true);
  });

  it('is false for a non-Microsoft domain', () => {
    expect(
      envIndicatesMicrosoftNetwork({ USERDNSDOMAIN: 'example.com', USERDOMAIN: 'HOME' }),
    ).toBe(false);
  });

  it('ignores non-string values', () => {
    expect(envIndicatesMicrosoftNetwork({ USERDNSDOMAIN: undefined })).toBe(false);
  });
});

describe('resolveMicrosoftNetwork', () => {
  it('honours a true override above all else', () => {
    expect(
      resolveMicrosoftNetwork({ override: true, envMicrosoft: false, endpointReachable: false }),
    ).toBe(true);
  });

  it('honours a false override above all else', () => {
    expect(
      resolveMicrosoftNetwork({ override: false, envMicrosoft: true, endpointReachable: true }),
    ).toBe(false);
  });

  it('returns true when env indicates Microsoft and no override', () => {
    expect(
      resolveMicrosoftNetwork({ override: null, envMicrosoft: true, endpointReachable: null }),
    ).toBe(true);
  });

  it('uses the endpoint probe when env is inconclusive', () => {
    expect(
      resolveMicrosoftNetwork({ override: null, envMicrosoft: false, endpointReachable: true }),
    ).toBe(true);
    expect(
      resolveMicrosoftNetwork({ override: null, envMicrosoft: false, endpointReachable: false }),
    ).toBe(false);
    expect(
      resolveMicrosoftNetwork({ override: null, envMicrosoft: false, endpointReachable: null }),
    ).toBe(false);
  });
});
