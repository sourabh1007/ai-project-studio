import type { Session, StoredUsage } from './types.js';

/** Normalized live events consumed by the reducer. */
export type StreamEvent =
  | { type: 'session.started'; session: Session }
  | { type: 'session.ended'; session: Session }
  | { type: 'session.output'; sessionId: string; line: string }
  | { type: 'usage.recorded'; usage: StoredUsage };

export interface LiveState {
  sessions: Record<string, Session>;
  usageByKey: Record<string, StoredUsage>;
  outputBySession: Record<string, string[]>;
}

export const initialLiveState: LiveState = {
  sessions: {},
  usageByKey: {},
  outputBySession: {},
};

/** Stable key that dedupes usage events by session + turn. */
export function usageKey(sessionId: string, turnIndex: number): string {
  return `${sessionId}:${turnIndex}`;
}

/**
 * Parses a raw backend SSE frame (event name + JSON data) into a normalized
 * {@link StreamEvent}, or null for frames we do not surface (e.g. process exit).
 */
export function parseServerEvent(
  name: string,
  data: string,
): StreamEvent | null {
  switch (name) {
    case 'session.started':
      return { type: 'session.started', session: JSON.parse(data) as Session };
    case 'session.ended':
      return { type: 'session.ended', session: JSON.parse(data) as Session };
    case 'session.output': {
      const payload = JSON.parse(data) as {
        sessionId: string;
        event: { type: string; line?: string };
      };
      if (payload.event.type === 'stdout' || payload.event.type === 'stderr') {
        return {
          type: 'session.output',
          sessionId: payload.sessionId,
          line: payload.event.line ?? '',
        };
      }
      return null;
    }
    case 'usage.recorded':
      return { type: 'usage.recorded', usage: JSON.parse(data) as StoredUsage };
    default:
      return null;
  }
}

/** Applies a stream event to the live state, returning a new immutable state. */
export function applyStreamEvent(
  state: LiveState,
  event: StreamEvent,
): LiveState {
  switch (event.type) {
    case 'session.started':
    case 'session.ended':
      return {
        ...state,
        sessions: { ...state.sessions, [event.session.id]: event.session },
      };
    case 'session.output': {
      const previous = state.outputBySession[event.sessionId] ?? [];
      return {
        ...state,
        outputBySession: {
          ...state.outputBySession,
          [event.sessionId]: [...previous, event.line],
        },
      };
    }
    case 'usage.recorded': {
      const key = usageKey(event.usage.sessionId, event.usage.turnIndex);
      return {
        ...state,
        usageByKey: { ...state.usageByKey, [key]: event.usage },
      };
    }
  }
}

export interface SessionLiveTotals {
  credits: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  nanoAiu: number;
  turns: number;
}

/** Aggregates the live usage captured so far for a single session. */
export function sessionLiveTotals(
  state: LiveState,
  sessionId: string,
): SessionLiveTotals {
  const totals: SessionLiveTotals = {
    credits: 0,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    nanoAiu: 0,
    turns: 0,
  };
  for (const usage of Object.values(state.usageByKey)) {
    if (usage.sessionId === sessionId) {
      totals.credits += usage.credits;
      totals.cost += usage.cost;
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.nanoAiu += usage.nanoAiu;
      totals.turns += 1;
    }
  }
  return totals;
}

/** Aggregates all live usage across every tracked session (status-bar total). */
export function workspaceLiveTotals(state: LiveState): SessionLiveTotals {
  const totals: SessionLiveTotals = {
    credits: 0,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    nanoAiu: 0,
    turns: 0,
  };
  for (const usage of Object.values(state.usageByKey)) {
    totals.credits += usage.credits;
    totals.cost += usage.cost;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.nanoAiu += usage.nanoAiu;
    totals.turns += 1;
  }
  return totals;
}

/**
 * A monotonic-ish signal that changes whenever a new session or usage event is
 * observed. Consumers use it as an effect dependency to re-fetch authoritative
 * persisted stats without depending on the (incomplete) live totals directly.
 */
export function liveSignal(state: LiveState): number {
  return (
    Object.keys(state.sessions).length + Object.keys(state.usageByKey).length
  );
}
