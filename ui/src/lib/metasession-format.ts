import type {
  ConfigValue,
  MetaSessionTurn,
} from './types.js';

/**
 * Purposes the IDE tags metasession turns with. These are attribution labels
 * for the usage/turn views — not routing keys: every turn draws from the one
 * shared pool.
 */
export const KNOWN_PURPOSES: Array<{
  purpose: string;
  label: string;
  hint: string;
}> = [
  {
    purpose: 'general',
    label: 'General',
    hint: 'Everyday AI turns — PR review, summaries, repo context, review board, monitors.',
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
  /** How many metasessions the shared pool keeps warm. */
  size: number;
  [key: string]: ConfigValue;
}

/**
 * Narrow an untyped config value to a {@link WarmPoolConfig}, or null when it is
 * missing/malformed, so callers can trust `enabled`/`size` without re-checking.
 */
export function readWarmPool(value: ConfigValue): WarmPoolConfig | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const wp = value as Record<string, unknown>;
  if (typeof wp.enabled !== 'boolean' || typeof wp.size !== 'number') {
    return null;
  }
  return wp as unknown as WarmPoolConfig;
}

/**
 * The warm-pool settings as last *saved*, which is what an editor must show.
 *
 * `current` is the config the backend booted with and it does not move when an
 * override is persisted, so reading it alone made every saved edit appear to
 * revert the moment the form reloaded — even though the value had been stored
 * and the live pools had already been resized to match.
 *
 * The stored override wins key by key, exactly as the backend merges it on the
 * next launch, so the form shows what is saved rather than what happened to be
 * loaded at boot.
 */
export function savedWarmPool(
  current: ConfigValue,
  override: ConfigValue,
): WarmPoolConfig | null {
  const running = current === null || typeof current !== 'object'
    ? {}
    : (current as Record<string, unknown>);
  const stored = override === null || typeof override !== 'object'
    ? {}
    : (override as Record<string, unknown>);
  return readWarmPool({ ...running, ...stored } as ConfigValue);
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
