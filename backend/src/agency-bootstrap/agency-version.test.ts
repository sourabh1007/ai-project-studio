import { describe, it, expect } from 'vitest';
import { parseAgencyVersion } from './agency-version.js';

describe('parseAgencyVersion', () => {
  it('extracts a plain semver token', () => {
    expect(parseAgencyVersion('1.4.2')).toBe('1.4.2');
  });

  it('extracts a semver embedded in prose', () => {
    expect(parseAgencyVersion('agency version 2.0.0 (build 99)')).toBe('2.0.0');
  });

  it('keeps pre-release and build suffixes', () => {
    expect(parseAgencyVersion('v3.1.0-beta.1+abc')).toBe('3.1.0-beta.1+abc');
  });

  it('falls back to the first non-empty line when no semver is present', () => {
    expect(parseAgencyVersion('\n\n  nightly-channel  \n')).toBe('nightly-channel');
  });

  it('returns null for empty or whitespace-only output', () => {
    expect(parseAgencyVersion('')).toBeNull();
    expect(parseAgencyVersion('   \n  \n')).toBeNull();
  });
});
