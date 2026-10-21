import { createHash, timingSafeEqual } from 'node:crypto';
import { AuthRequiredError, ConfigError, ConflictError } from '../kernel/error-types.js';
import type { MobileConfig } from './config.js';

export const mobileHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

export function mobileOrigin(config: MobileConfig): string {
  let url: URL;
  try {
    url = new URL(config.publicOrigin);
  } catch {
    throw new ConfigError('Mobile publicOrigin must be a complete HTTPS origin.');
  }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash ||
      !/^[a-f0-9]{64}$/.test(config.accessKeyHash)) {
    throw new ConfigError('Mobile requires an HTTPS origin without a path and a SHA256 access-key hash.');
  }
  return url.origin;
}

export function createMobileAccess(deps: {
  config: MobileConfig;
  now: () => number;
  token: () => string;
}) {
  const sessions = new Map<string, number>();
  let windowStart = deps.now();
  let attempts = 0;
  const rejected = () => new AuthRequiredError('Mobile access key or session is invalid.');
  const hash = Buffer.from(deps.config.accessKeyHash, 'hex');
  return {
    login(key: string): string {
      const now = deps.now();
      if (now - windowStart >= 60000) {
        windowStart = now;
        attempts = 0;
      }
      if (++attempts > deps.config.loginAttemptsPerMinute) {
        throw new ConflictError('Too many sign-in attempts. Wait one minute.');
      }
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(key) ||
          !timingSafeEqual(Buffer.from(mobileHash(key), 'hex'), hash)) {
        throw rejected();
      }
      for (const [tokenHash, expires] of sessions) {
        if (expires <= now) sessions.delete(tokenHash);
      }
      if (sessions.size >= deps.config.maxSessions) {
        throw new ConflictError('The mobile device limit is reached. Sign out another device or restart the mobile host.');
      }
      const token = deps.token();
      sessions.set(mobileHash(token), now + deps.config.sessionTtlMs);
      return token;
    },
    authorize(token: string): void {
      if (token.length > 128) throw rejected();
      const tokenHash = mobileHash(token);
      const expires = sessions.get(tokenHash);
      if (expires === undefined || expires <= deps.now()) {
        sessions.delete(tokenHash);
        throw rejected();
      }
    },
    logout(token: string): void {
      sessions.delete(mobileHash(token));
    },
  };
}
