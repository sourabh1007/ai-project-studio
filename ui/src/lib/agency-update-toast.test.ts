import { describe, it, expect } from 'vitest';
import {
  deriveAgencyUpdateToast,
  isAgencyUpgradeTerminal,
} from './agency-update-toast.js';
import type { AgencyStatus } from './types.js';

describe('deriveAgencyUpdateToast', () => {
  it('returns null when status is missing', () => {
    expect(deriveAgencyUpdateToast(null)).toBeNull();
    expect(deriveAgencyUpdateToast(undefined)).toBeNull();
  });

  it('returns null when agency is not installed', () => {
    const status: AgencyStatus = {
      installed: false,
      upgrade: { phase: 'done', updated: true, version: '1.1.0' },
    };
    expect(deriveAgencyUpdateToast(status)).toBeNull();
  });

  it('returns null when there is no upgrade state', () => {
    expect(deriveAgencyUpdateToast({ installed: true })).toBeNull();
  });

  it('returns null while the upgrade is still running', () => {
    const status: AgencyStatus = {
      installed: true,
      upgrade: { phase: 'upgrading' },
    };
    expect(deriveAgencyUpdateToast(status)).toBeNull();
  });

  it('returns null on a no-op done run (updated not true)', () => {
    const status: AgencyStatus = {
      installed: true,
      upgrade: { phase: 'done', updated: false, version: '1.0.0' },
    };
    expect(deriveAgencyUpdateToast(status)).toBeNull();
  });

  it('reports a from/to detail when both versions are known', () => {
    const status: AgencyStatus = {
      installed: true,
      upgrade: {
        phase: 'done',
        updated: true,
        version: '1.1.0',
        previousVersion: '1.0.0',
      },
    };
    expect(deriveAgencyUpdateToast(status)).toEqual({
      headline: 'Agency CLI updated',
      detail: 'Updated from 1.0.0 to 1.1.0.',
    });
  });

  it('reports a to-only detail when the previous version is unknown', () => {
    const status: AgencyStatus = {
      installed: true,
      upgrade: { phase: 'done', updated: true, version: '2.0.0' },
    };
    expect(deriveAgencyUpdateToast(status)?.detail).toBe('Updated to 2.0.0.');
  });

  it('falls back to a generic detail when no version is known', () => {
    const status: AgencyStatus = {
      installed: true,
      upgrade: { phase: 'done', updated: true },
    };
    expect(deriveAgencyUpdateToast(status)?.detail).toBe(
      'The latest version is now active.',
    );
  });
});

describe('isAgencyUpgradeTerminal', () => {
  it('is false when there is no upgrade or it is still running', () => {
    expect(isAgencyUpgradeTerminal(null)).toBe(false);
    expect(isAgencyUpgradeTerminal({ installed: true })).toBe(false);
    expect(
      isAgencyUpgradeTerminal({ installed: true, upgrade: { phase: 'upgrading' } }),
    ).toBe(false);
  });

  it('is true on done or error', () => {
    expect(
      isAgencyUpgradeTerminal({ installed: true, upgrade: { phase: 'done' } }),
    ).toBe(true);
    expect(
      isAgencyUpgradeTerminal({ installed: true, upgrade: { phase: 'error' } }),
    ).toBe(true);
  });
});
