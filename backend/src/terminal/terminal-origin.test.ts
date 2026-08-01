import { describe, it, expect } from 'vitest';
import { isAllowedTerminalOrigin } from './terminal-origin.js';

describe('isAllowedTerminalOrigin', () => {
  it('allows a missing origin (non-browser client)', () => {
    expect(isAllowedTerminalOrigin(undefined)).toBe(true);
    expect(isAllowedTerminalOrigin(null)).toBe(true);
    expect(isAllowedTerminalOrigin('')).toBe(true);
  });

  it('allows localhost origins on any port', () => {
    expect(isAllowedTerminalOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedTerminalOrigin('http://127.0.0.1:52176')).toBe(true);
    expect(isAllowedTerminalOrigin('http://[::1]:4319')).toBe(true);
  });

  it('rejects cross-site origins', () => {
    expect(isAllowedTerminalOrigin('https://evil.example.com')).toBe(false);
    expect(isAllowedTerminalOrigin('http://attacker.test:1234')).toBe(false);
  });

  it('rejects malformed or opaque origins', () => {
    expect(isAllowedTerminalOrigin('null')).toBe(false);
    expect(isAllowedTerminalOrigin('not a url')).toBe(false);
  });
});
