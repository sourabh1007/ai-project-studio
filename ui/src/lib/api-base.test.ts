import { describe, expect, it } from 'vitest';
import { resolveApiBase } from './api-base.js';

describe('resolveApiBase', () => {
  it('prefers the window-injected absolute base', () => {
    expect(
      resolveApiBase('http://127.0.0.1:4319/api', 'http://env/api'),
    ).toBe('http://127.0.0.1:4319/api');
  });

  it('falls back to the env base when no window base', () => {
    expect(resolveApiBase(undefined, 'http://env/api')).toBe('http://env/api');
  });

  it('ignores an empty window base', () => {
    expect(resolveApiBase('', 'http://env/api')).toBe('http://env/api');
  });

  it('ignores an empty env base', () => {
    expect(resolveApiBase(undefined, '')).toBe('/api');
  });

  it('defaults to /api when nothing is provided', () => {
    expect(resolveApiBase(undefined, undefined)).toBe('/api');
  });
});
