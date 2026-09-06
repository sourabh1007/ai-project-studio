import type {
  ConfigValue,
  MetaSessionTurn,
} from './types.js';

/**
 * Purposes the IDE routes metasession work to. `general` is the required
 * fallback for any request without a dedicated pool; the others are workflow
 * routing keys used across the app. Surfaced so users don't have to guess what
 * to type when adding a pool.
 */
export const KNOWN_PURPOSES: Array<{
  purpose: string;
  label: string;
  hint: string;
}> = [
  {
    purpose: 'general',
    label: 'General',
    hint: 'Fallback for every AI turn without a dedicated pool — PR review, summaries, repo context, review board, monitors.',
  },
  {
    purpose: 'self-recovery',
    label: 'Self-recovery',
    hint: 'Read-only diagnosis turns that analyze a stuck session and suggest a fix.',
  },
];

/** The persisted warm-pool config shape read out of the raw settings value. */
export interface WarmPoolConfig {
  enabled: boolean;
  pools: Array<{ purpose: string; size: number }>;
  [key: string]: ConfigValue;
}

/**
 * Narrow an untyped config value to a {@link WarmPoolConfig}, or null when it is
 * missing/malformed, so callers can trust `enabled`/`pools` without re-checking.
 */
export function readWarmPool(value: ConfigValue): WarmPoolConfig | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const wp = value as Record<string, unknown>;
  if (typeof wp.enabled !== 'boolean' || !Array.isArray(wp.pools)) {
    return null;
  }
  return wp as unknown as WarmPoolConfig;
}

/** The trailing numeric sequence of a session id (`meta-12` → 12); 0 if none. */
export function sessionSeq(id: string): number {
  const n = Number.parseInt(id.replace(/^\D+/, ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Formats an elapsed millisecond span as a compact `1h 2m 3s` duration. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return '0s';
  }
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h > 0) {
    parts.push(`${h}h`);
  }
  if (h > 0 || m > 0) {
    parts.push(`${m}m`);
  }
  parts.push(`${s}s`);
  return parts.join(' ');
}

/** Formats an epoch millisecond timestamp as a local wall-clock time. */
export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString();
}

/** Formats a token count compactly (e.g. 1234 → "1,234", 0 → "0"). */
export function formatTokens(n: number): string {
  return n.toLocaleString();
}

/** Human label for a routing purpose (the "where in the IDE" of a turn). */
export function purposeLabel(purpose: string): string {
  const known = KNOWN_PURPOSES.find((p) => p.purpose === purpose);
  return known ? known.label : purpose;
}

/**
 * What a turn was used for: the caller-supplied work label when present (e.g.
 * "Repository analysis"), otherwise the coarse routing purpose. This is what
 * turns the opaque "General" rows into a real description of the work.
 */
export function turnWork(turn: MetaSessionTurn): string {
  return turn.label ?? purposeLabel(turn.purpose);
}
