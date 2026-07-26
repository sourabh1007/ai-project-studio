import { describe, it, expect } from 'vitest';
import { withTabsDisabled } from './copilot-settings.js';

describe('withTabsDisabled', () => {
  it('creates a minimal settings object when none exists', () => {
    const result = withTabsDisabled(null);
    expect(JSON.parse(result)).toEqual({ tabs: { enabled: false } });
    expect(result.endsWith('\n')).toBe(true);
  });

  it('preserves unrelated settings while disabling the tab bar', () => {
    const existing = JSON.stringify({
      logLevel: 'all',
      allowedUrls: ['https://example.com'],
    });
    expect(JSON.parse(withTabsDisabled(existing))).toEqual({
      logLevel: 'all',
      allowedUrls: ['https://example.com'],
      tabs: { enabled: false },
    });
  });

  it('preserves other tabs.* keys and forces enabled to false', () => {
    const existing = JSON.stringify({ tabs: { sort: 'recent', enabled: true } });
    expect(JSON.parse(withTabsDisabled(existing))).toEqual({
      tabs: { sort: 'recent', enabled: false },
    });
  });

  it('resets from an empty object when the file is malformed JSON', () => {
    expect(JSON.parse(withTabsDisabled('{ not json'))).toEqual({
      tabs: { enabled: false },
    });
  });

  it('resets when the root JSON is not an object', () => {
    expect(JSON.parse(withTabsDisabled('[1, 2, 3]'))).toEqual({
      tabs: { enabled: false },
    });
  });

  it('ignores a non-object tabs value', () => {
    const existing = JSON.stringify({ tabs: 'yes' });
    expect(JSON.parse(withTabsDisabled(existing))).toEqual({
      tabs: { enabled: false },
    });
  });
});
