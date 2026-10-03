import { describe, it, expect } from 'vitest';
import { installedProviders, installedProviderIds } from './providers.js';
import type { ProviderInfo } from './types.js';

const list: ProviderInfo[] = [
  { id: 'copilot', installed: true },
  { id: 'agency', installed: false },
  { id: 'claude', installed: true },
];

describe('installedProviders', () => {
  it('keeps only installed providers', () => {
    expect(installedProviders(list)).toEqual([
      { id: 'copilot', installed: true },
      { id: 'claude', installed: true },
    ]);
  });

  it('returns an empty list when none are installed', () => {
    expect(installedProviders([{ id: 'x', installed: false }])).toEqual([]);
  });
});

describe('installedProviderIds', () => {
  it('returns the ids of installed providers as a set', () => {
    expect(installedProviderIds(list)).toEqual(new Set(['copilot', 'claude']));
  });
});
