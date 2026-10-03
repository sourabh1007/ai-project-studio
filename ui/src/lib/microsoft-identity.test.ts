import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  getMicrosoftSignedIn,
  setMicrosoftSignedIn,
  subscribeMicrosoftSignedIn,
  isAgencyHidden,
  isProviderExposed,
  MICROSOFT_ONLY_PROVIDER_IDS,
  resetMicrosoftSignedIn,
} from './microsoft-identity.js';

describe('microsoft-identity store', () => {
  beforeEach(() => {
    resetMicrosoftSignedIn();
  });

  it('starts unknown (undefined) and shows Agency', () => {
    expect(getMicrosoftSignedIn()).toBeUndefined();
    expect(isAgencyHidden(getMicrosoftSignedIn())).toBe(false);
  });

  it('notifies subscribers only on a real change', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMicrosoftSignedIn(listener);

    setMicrosoftSignedIn(undefined);
    expect(listener).not.toHaveBeenCalled();

    setMicrosoftSignedIn(true);
    expect(getMicrosoftSignedIn()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(true);

    setMicrosoftSignedIn(true);
    expect(listener).toHaveBeenCalledOnce();

    setMicrosoftSignedIn(false);
    expect(listener).toHaveBeenLastCalledWith(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setMicrosoftSignedIn(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('hides Agency only when positively signed out', () => {
    expect(isAgencyHidden(false)).toBe(true);
    expect(isAgencyHidden(true)).toBe(false);
    expect(isAgencyHidden(undefined)).toBe(false);
  });

  it('exposes Microsoft-only providers only when not signed out', () => {
    expect(MICROSOFT_ONLY_PROVIDER_IDS.has('agency')).toBe(true);
    expect(isProviderExposed('copilot', false)).toBe(true);
    expect(isProviderExposed('copilot', undefined)).toBe(true);
    expect(isProviderExposed('agency', true)).toBe(true);
    expect(isProviderExposed('agency', undefined)).toBe(true);
    expect(isProviderExposed('agency', false)).toBe(false);
  });
});
