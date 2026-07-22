import type { SessionStatus } from './types.js';

/** Formats a credit amount to a fixed, human-readable precision. */
export function formatCredits(credits: number): string {
  return `${credits.toFixed(2)} credits`;
}

/**
 * Nano-AIU per AI credit (AIC). The Copilot/Agency CLIs report usage as
 * `github.copilot.nano_aiu`; the CLI's own "AIC used" figure is that value
 * divided by this constant. We surface the vendor number rather than computing
 * our own so the app always matches the CLI.
 */
export const NANO_AIU_PER_AIC = 1_000_000_000;

/** Converts the vendor's raw nano-AIU into AI credits (AIC). */
export function nanoAiuToAic(nanoAiu: number): number {
  return nanoAiu / NANO_AIU_PER_AIC;
}

/** Formats vendor nano-AIU as an AIC figure (e.g. 1742242500 → "1.74"). */
export function formatAic(nanoAiu: number): string {
  return nanoAiuToAic(nanoAiu).toFixed(2);
}

/** Formats the provider-reported cost value. */
export function formatCost(cost: number): string {
  return cost.toFixed(2);
}

/** Formats a token count with thousands separators. */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

/**
 * Formats a number compactly for dense UI (e.g. inline session metrics):
 * 999 → "999", 23807 → "23.8k", 1500000 → "1.5M".
 */
export function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) {
    return String(value);
  }
  if (abs < 1_000_000) {
    return `${roundToOne(value / 1000)}k`;
  }
  return `${roundToOne(value / 1_000_000)}M`;
}

function roundToOne(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** Renders an ISO timestamp as a locale date-time, or a dash when absent. */
export function formatDateTime(iso: string | null): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString('en-US');
}

const STATUS_LABELS: Record<SessionStatus, string> = {
  created: 'Created',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Human-readable label for a session status. */
export function statusLabel(status: SessionStatus): string {
  return STATUS_LABELS[status];
}

/** Sums token usage into a single input+output+reasoning total. */
export function totalTokens(totals: {
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}): number {
  return (
    totals.inputTokens + totals.outputTokens + totals.reasoningOutputTokens
  );
}

/**
 * Formats a duration in milliseconds as a compact human-readable string:
 * 0 → "0s", 45000 → "45s", 90000 → "1m 30s", 3660000 → "1h 1m",
 * 90000000 → "1d 1h". Negative values are clamped to 0.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
