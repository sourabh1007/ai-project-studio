import { describe, expect, it } from 'vitest';
import { mobileConfigSchema, mobileDefaults } from './config.js';
import { createMobileAccess, mobileHash, mobileOrigin } from './mobile-access.js';

const key = 'k'.repeat(43);
const config = { ...mobileDefaults, publicOrigin: 'https://studio.example', accessKeyHash: mobileHash(key) };

describe('mobile access', () => {
  it('validates configuration without enabling remote access by default', () => {
    expect(mobileConfigSchema.parse(mobileDefaults).enabled).toBe(false);
    expect(mobileOrigin(config)).toBe('https://studio.example');
    for (const publicOrigin of ['', 'http://studio.example', 'https://user@studio.example',
      'https://user:pass@studio.example', 'https://studio.example/path', 'https://studio.example/?key=x',
      'https://studio.example/#x']) {
      expect(() => mobileOrigin({ ...config, publicOrigin })).toThrow();
    }
    expect(() => mobileOrigin({ ...config, accessKeyHash: 'bad' })).toThrow();
  });
  it('uses revocable, expiring random sessions, not the long-lived access key', () => {
    let now = 0;
    let id = 0;
    const access = createMobileAccess({ config, now: () => now, token: () => `token-${++id}` });
    expect(() => access.login('short')).toThrow('invalid');
    expect(() => access.login('a'.repeat(43))).toThrow('invalid');
    const token = access.login(key);
    expect(token).not.toBe(key);
    expect(() => access.authorize(key)).toThrow('invalid');
    expect(() => access.authorize('x'.repeat(129))).toThrow('invalid');
    access.authorize(token);
    access.logout(token);
    expect(() => access.authorize(token)).toThrow('invalid');
    const next = access.login(key);
    now = config.sessionTtlMs;
    expect(() => access.authorize(next)).toThrow('invalid');
  });
  it('bounds devices and global sign-in attempts, pruning expired sessions', () => {
    let now = 0;
    let token = 0;
    const access = createMobileAccess({
      config: { ...config, maxSessions: 1, loginAttemptsPerMinute: 3, sessionTtlMs: 100 },
      now: () => now, token: () => `session-${++token}`,
    });
    access.login(key);
    expect(() => access.login(key)).toThrow('device limit');
    now = 100;
    access.login(key);
    expect(() => access.login(key)).toThrow('one minute');
    now = 60000;
    access.login(key);
    access.logout('unknown');
  });
});
