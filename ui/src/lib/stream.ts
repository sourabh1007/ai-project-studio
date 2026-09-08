import type {
  ContextStatus,
  ContextStatusPhase,
  PrReview,
  RepositoryContext,
  ReviewBoardActivity,
  Session,
  StoredUsage,
  Automation,
  Subagent,
} from './types.js';

/** Normalized live events consumed by the reducer. */
export type StreamEvent =
  | { type: 'stream.interrupted' | 'stream.reconnected' | 'stream.truncated' }
  | { type: 'session.started'; session: Session }
  | { type: 'session.ended'; session: Session }
  | { type: 'session.updated'; session: Session }
  | { type: 'session.file'; sessionId: string }
  | {
      type: 'session.notice';
      sessionId: string;
      level: 'info' | 'error';
      message: string;
    }
  | { type: 'usage.recorded'; usage: StoredUsage }
  | { type: 'repository.context.updated'; context: RepositoryContext }
  | { type: 'pr.review.updated'; review: PrReview }
  | { type: 'context.status'; status: ContextStatus }
  | { type: 'automation.updated'; automation: Automation }
  | { type: 'automation.removed'; id: string }
  | { type: 'subagent.updated'; subagent: Subagent }
  | { type: 'review.board.activity'; activity: ReviewBoardActivity };

/** Stable key for a context-status entry: one live phase per scope target. */
export function contextStatusKey(scope: string, scopeId: string): string {
  return `${scope}:${scopeId}`;
}

/** Stable key for a perspective's live activity: one stream per feature+lens. */
export function reviewBoardActivityKey(
  featureId: string,
  perspectiveId: string,
): string {
  return `${featureId}:${perspectiveId}`;
}

/** The most recent live activity captured for one perspective's run. */
export interface ReviewBoardActivityState {
  /** The metasession the lines belong to; a new id resets the buffer. */
  sessionId: string;
  /** Most recent activity lines, oldest first, capped to the tail. */
  lines: string[];
}

/** How many trailing activity lines to keep per perspective run. */
const MAX_ACTIVITY_LINES = 60;

export interface LiveState {
  revision?: number;
  sessionRevision?: number;
  streamInterrupted?: boolean;
  liveCacheTruncated?: boolean;
  usageHistoryTruncated?: boolean;
  cacheCharacters?: Partial<Record<LiveCollection, number>>;
  sessions: Record<string, Session>;
  usageByKey: Record<string, StoredUsage>;
  repositoryContexts: Record<string, RepositoryContext>;
  prReviews: Record<string, PrReview>;
  contextStatus: Record<string, ContextStatusPhase>;
  automations: Record<string, Automation>;
  subagents: Record<string, Subagent>;
  /** Live per-perspective review-board activity, keyed by feature+perspective. */
  reviewBoardActivity: Record<string, ReviewBoardActivityState>;
  /**
   * Per-session count of observed file create/edit events. Bumps on every
   * `session.file`; consumers use it as an effect dependency to re-fetch the
   * authoritative session file list so the Files view updates live.
   */
  fileChangesBySession: Record<string, number>;
}

export const initialLiveState: LiveState = {
  sessions: {},
  usageByKey: {},
  repositoryContexts: {},
  prReviews: {},
  contextStatus: {},
  automations: {},
  subagents: {},
  reviewBoardActivity: {},
  fileChangesBySession: {},
};

type LiveCollection = 'sessions' | 'usageByKey' | 'repositoryContexts' | 'prReviews' |
  'contextStatus' | 'automations' | 'subagents' | 'reviewBoardActivity' | 'fileChangesBySession';

export const MAX_LIVE_CACHE_ENTRIES = 256;
export const MAX_LIVE_CACHE_CHARACTERS = 256 * 1024;
export const MAX_LIVE_EVENT_CHARACTERS = 1024 * 1024;
const STATS_EVENTS = new Set([
  'session.started', 'session.ended', 'session.updated', 'usage.recorded',
  'stream.interrupted', 'stream.reconnected', 'stream.truncated',
]);
const SESSION_EVENTS = new Set([
  'session.started', 'session.ended', 'session.updated',
  'stream.interrupted', 'stream.reconnected', 'stream.truncated',
]);

function entryCharacters(key: string, value: unknown): number {
  return key.length + JSON.stringify(value).length;
}

/** Bound each derived cache, never the authoritative persisted usage ledger. */
function retain<K extends LiveCollection>(
  state: LiveState, collection: K, key: string, value: LiveState[K][string] | undefined,
): LiveState {
  const rows = { ...state[collection] };
  let characters: number = state.cacheCharacters?.[collection] ??
    Object.entries(rows).reduce<number>((total, [id, item]) => total + entryCharacters(id, item), 0);
  if (Object.hasOwn(rows, key)) {
    characters -= entryCharacters(key, rows[key]);
    delete rows[key];
  }
  let truncated = false;
  if (value !== undefined) {
    const size = entryCharacters(key, value);
    if (size <= MAX_LIVE_CACHE_CHARACTERS) {
      rows[key] = value;
      characters += size;
    } else {
      truncated = true;
    }
  }
  const keys = Object.keys(rows);
  let count = keys.length;
  for (const id of keys) {
    if (count <= MAX_LIVE_CACHE_ENTRIES && characters <= MAX_LIVE_CACHE_CHARACTERS) break;
    characters -= entryCharacters(id, rows[id]);
    delete rows[id];
    count--;
    truncated = true;
  }
  return {
    ...state,
    [collection]: rows,
    cacheCharacters: { ...state.cacheCharacters, [collection]: characters },
    liveCacheTruncated: state.liveCacheTruncated === true || truncated,
    usageHistoryTruncated: state.usageHistoryTruncated === true || (collection === 'usageByKey' && truncated),
  };
}

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
    case 'session.updated':
      return { type: 'session.updated', session: JSON.parse(data) as Session };
    case 'session.file':
      return {
        type: 'session.file',
        sessionId: (JSON.parse(data) as { sessionId: string }).sessionId,
      };
    case 'session.notice': {
      const payload = JSON.parse(data) as {
        sessionId: string;
        level?: 'info' | 'error';
        message: string;
      };
      return {
        type: 'session.notice',
        sessionId: payload.sessionId,
        level: payload.level === 'error' ? 'error' : 'info',
        message: payload.message,
      };
    }
    case 'usage.recorded':
      return { type: 'usage.recorded', usage: JSON.parse(data) as StoredUsage };
    case 'repository.context.updated':
      return {
        type: 'repository.context.updated',
        context: JSON.parse(data) as RepositoryContext,
      };
    case 'pr.review.updated':
      return {
        type: 'pr.review.updated',
        review: JSON.parse(data) as PrReview,
      };
    case 'context.status':
      return {
        type: 'context.status',
        status: JSON.parse(data) as ContextStatus,
      };
    case 'automation.updated':
      return {
        type: 'automation.updated',
        automation: JSON.parse(data) as Automation,
      };
    case 'automation.removed':
      return {
        type: 'automation.removed',
        id: (JSON.parse(data) as { id: string }).id,
      };
    case 'subagent.updated':
      return {
        type: 'subagent.updated',
        subagent: JSON.parse(data) as Subagent,
      };
    case 'review.board.activity':
      return {
        type: 'review.board.activity',
        activity: JSON.parse(data) as ReviewBoardActivity,
      };
    default:
      return null;
  }
}

/** Applies a stream event to the live state, returning a new immutable state. */
export function applyStreamEvent(
  state: LiveState,
  event: StreamEvent,
): LiveState {
  const next = reduceStreamEvent(state, event);
  return next === state ? state : {
    ...next,
    revision: liveSignal(state) + (STATS_EVENTS.has(event.type) ? 1 : 0),
    sessionRevision: (state.sessionRevision ?? 0) + (SESSION_EVENTS.has(event.type) ? 1 : 0),
  };
}

function reduceStreamEvent(state: LiveState, event: StreamEvent): LiveState {
  switch (event.type) {
    case 'stream.interrupted':
      return { ...state, streamInterrupted: true, usageHistoryTruncated: true };
    case 'stream.reconnected':
      // Reconnection is not replay: keep any missing-history warning until the view reloads.
      return { ...state };
    case 'stream.truncated':
      return { ...state, liveCacheTruncated: true, usageHistoryTruncated: true };
    case 'session.started':
    case 'session.ended':
    case 'session.updated':
      return retain(state, 'sessions', event.session.id, event.session);
    case 'session.file': {
      const previous = state.fileChangesBySession[event.sessionId] ?? 0;
      return retain(state, 'fileChangesBySession', event.sessionId, previous + 1);
    }
    case 'session.notice':
      // A transient IDE notice (e.g. a self-recovery failure). It drives the
      // status bar directly in the stream hook and holds no live state, so the
      // reduced snapshot is unchanged.
      return state;
    case 'usage.recorded': {
      const key = usageKey(event.usage.sessionId, event.usage.turnIndex);
      return retain(state, 'usageByKey', key, event.usage);
    }
    case 'repository.context.updated':
      return retain(state, 'repositoryContexts', event.context.repositoryId, event.context);
    case 'pr.review.updated':
      return retain(state, 'prReviews', event.review.featureId, event.review);
    case 'context.status':
      return retain(state, 'contextStatus', contextStatusKey(event.status.scope, event.status.scopeId), event.status.phase);
    case 'automation.updated':
      return retain(state, 'automations', event.automation.id, event.automation);
    case 'automation.removed':
      return retain(state, 'automations', event.id, undefined);
    case 'subagent.updated':
      return retain(state, 'subagents', event.subagent.id, event.subagent);
    case 'review.board.activity': {
      const { featureId, perspectiveId, sessionId, line } = event.activity;
      const key = reviewBoardActivityKey(featureId, perspectiveId);
      const previous = state.reviewBoardActivity[key];
      // A new metasession id means a fresh run/attempt — reset the buffer so
      // stale lines from a prior run never bleed into the new one.
      const lines =
        previous && previous.sessionId === sessionId
          ? [...previous.lines, line].slice(-MAX_ACTIVITY_LINES)
          : [line];
      return retain(state, 'reviewBoardActivity', key, { sessionId, lines });
    }
  }
}

/** The live activity lines captured for one perspective, oldest first. */
export function reviewBoardActivityLines(
  state: LiveState,
  featureId: string,
  perspectiveId: string,
): string[] {
  return (
    state.reviewBoardActivity[
      reviewBoardActivityKey(featureId, perspectiveId)
    ]?.lines ?? []
  );
}

export interface SessionLiveTotals {
  complete?: false;
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
  return state.usageHistoryTruncated ? { ...totals, complete: false } : totals;
}

/** The usage metrics rendered for a single session row. */
export interface SessionMetrics {
  nanoAiu: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Selects the metrics to display for a session row. The persisted rollup is the
 * authoritative source of truth — every usage event is persisted and emitted on
 * the backend together, so the rollup is complete across reloads whereas the
 * live SSE feed only carries events observed since the UI connected. Preferring
 * persisted keeps the per-session AIC in lockstep with the persisted-based
 * status bar. Live totals are used only as a fallback for brand-new sessions
 * whose first events have not yet been folded into the refreshed rollup.
 */
export function resolveSessionMetrics(
  persisted: SessionMetrics | undefined,
  liveTotals: SessionMetrics & { complete?: false },
): SessionMetrics | null {
  if (persisted === undefined && liveTotals.complete === false) return null;
  const source = persisted ?? liveTotals;
  return {
    nanoAiu: source.nanoAiu,
    inputTokens: source.inputTokens,
    outputTokens: source.outputTokens,
  };
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
  return state.usageHistoryTruncated ? { ...totals, complete: false } : totals;
}

/**
 * Changes on corrections, reconnection and eviction as well as new events so
 * persisted totals refresh even when the bounded cache's entry count is unchanged.
 */
export function liveSignal(state: LiveState): number {
  return (
    state.revision ?? (Object.keys(state.sessions).length + Object.keys(state.usageByKey).length)
  );
}

/**
 * Merge a persisted session with any live status/model updates streamed since it
 * was loaded. Returns the original object unchanged when there is no live entry,
 * so callers can rely on referential stability for untouched rows.
 */
export function mergeLive(session: Session, live: LiveState): Session {
  const liveSession = live.sessions[session.id];
  return liveSession && !live.streamInterrupted ? { ...session, ...liveSession } : session;
}
