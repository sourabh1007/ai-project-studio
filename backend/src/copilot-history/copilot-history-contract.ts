/**
 * Contracts for reading the Copilot/Agency CLI's own session history. The app
 * launches every CLI session with `--session-id <ourSessionId>`, so our session
 * ids are the exact keys into the CLI's `session-store.db`.
 */

/** A single checkpoint the CLI recorded for a session (AI-written). */
export interface CheckpointSummary {
  number: number;
  title: string;
  overview: string;
  createdAt: string;
}

/** Lifecycle of a prompt, derived from the recorded response and liveness. */
export type PromptStatus = 'answered' | 'answering' | 'unanswered';

/** One prompt the user sent during a session, with its answer and timing. */
export interface SessionPrompt {
  /** Zero-based turn order, ascending (oldest first). */
  index: number;
  /** The user's message text for this turn. */
  text: string;
  /** ISO timestamp the prompt was entered, or '' when unknown. */
  at: string;
  /** The assistant's recorded reply, or null when none is stored yet. */
  response: string | null;
  /** Lifecycle status for the status icon: answered / answering / unanswered. */
  status: PromptStatus;
  /** ISO timestamp the answer completed, or null when not derivable. */
  answeredAt: string | null;
  /** Wall-clock milliseconds from prompt to answer, or null when unknown. */
  durationMs: number | null;
  /**
   * True for a live row whose prompt/response has not reached the CLI store
   * yet. Persistence can lag behind generation, including after completion.
   */
  pending?: boolean;
  /** Submitted while another prompt is still being answered. */
  queued?: boolean;
}

/** The CLI's recorded history for one session. */
export interface SessionHistory {
  sessionId: string;
  /** The CLI's one-line session summary, if it produced one. */
  summary: string | null;
  /** The first user prompt recorded by the CLI, if present. */
  firstUserMessage: string | null;
  checkpoints: CheckpointSummary[];
}

/** Raw session-summary row from the CLI store. */
export interface HistorySessionRow {
  id: string;
  summary: string | null;
  first_user_message: string | null;
}

/** Raw checkpoint row from the CLI store. */
export interface HistoryCheckpointRow {
  session_id: string;
  checkpoint_number: number;
  title: string | null;
  overview: string | null;
  created_at: string;
}

/** Raw user-message (turn) row from the CLI store. */
export interface HistoryUserMessageRow {
  turn_index: number;
  user_message: string | null;
  assistant_response: string | null;
  timestamp: string | null;
}

/**
 * Low-level access to the CLI store. Isolated behind a port so the aggregation
 * logic stays pure and the node:sqlite adapter is the only DB-aware piece.
 */
export interface CopilotHistorySource {
  /** True when the underlying store exists and can be opened. */
  available(): boolean;
  /** Session summary rows for the given ids (order/absence not guaranteed). */
  sessionSummaries(sessionIds: string[]): HistorySessionRow[];
  /** Checkpoint rows for the given session ids. */
  checkpoints(sessionIds: string[]): HistoryCheckpointRow[];
  /**
   * User-message rows for one session, ascending by turn index. Empty only when
   * the store is absent or has no turns; throws PromptHistoryUnavailableError
   * when the store exists but the read fails (lock, corruption, schema drift).
   */
  userMessages(sessionId: string): HistoryUserMessageRow[];
  /** Bounded text projection, ascending, for incremental background consumers. */
  recentUserMessages?(sessionId: string, limit: number): HistoryUserMessageRow[];
  /**
   * ISO timestamps of the assistant usage events recorded for one session,
   * ascending. Used to derive per-prompt answer completion time by bucketing
   * each event into the prompt window it falls in (the usage events' own
   * turn_index is unreliable, so timing is matched by wall-clock instead).
   */
  usageEventTimes(sessionId: string): string[];
  /**
   * The highest turn index the CLI has recorded a usage event for, or null when
   * none exist. Usage events are written live as the assistant responds, so a
   * value beyond the last persisted turn reveals an in-flight turn whose
   * prompt/response text the store has not finalised yet.
   */
  latestActivityTurn(sessionId: string): number | null;
}

/**
 * The latest in-flight turn the CLI has logged live for a session, read from the
 * CLI's own `events.jsonl` event log rather than its SQLite store. The store
 * only persists a turn's prompt/response text at the *next* turn boundary, so a
 * just-typed prompt (and its streaming reply) is invisible there until the user
 * asks again. The event log, by contrast, records the user message the instant
 * it is sent and appends each assistant message as it is produced — so this is
 * the only source that can show the current prompt and answer in real time.
 */
export interface LivePromptTurn {
  /** The user's latest prompt text, exactly as typed. */
  text: string;
  /** ISO timestamp the prompt was sent, or '' when unknown. */
  at: string;
  /**
   * The assistant's reply so far for this turn, concatenated from the live
   * event stream, or null when the assistant has not emitted prose text yet
   * (e.g. it is still running tools).
   */
  response: string | null;
  /** Recorded turn-end time, null if missing/invalid; absent until completion. */
  completedAt?: string | null;
  /** Timestamp of the newest valid event logged for this turn, when present. */
  lastActivityAt?: string | null;
  /** Waiting for its own assistant turn, rather than borrowing another reply. */
  queued?: boolean;
  /** Earlier recent turns, retained while several prompts await persistence. */
  preceding?: LivePromptTurn[];
}

/**
 * Reads the most recent genuine (non-injected) user turn for a session from the
 * CLI's live event log. Isolated behind a port so the reader stays pure and the
 * filesystem tail-read is the only IO-aware piece.
 */
export interface LivePromptSource {
  /**
   * The latest live turn for one session, or null when the log does not exist.
   * Rejects (rather than returning null) when the log exists but cannot be
   * read, so callers can distinguish absence from a failed read. Aborting
   * `signal` must stop the underlying work, not merely stop waiting for it.
   */
  latest(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<LivePromptTurn | null> | LivePromptTurn | null;
}

/** Aggregates raw CLI rows into per-session history. */
export interface CopilotHistoryReader<
  P extends Promise<SessionPrompt[]> | SessionPrompt[] = SessionPrompt[],
> {
  read(sessionIds: string[]): SessionHistory[];
  /**
   * Every prompt the user sent in a session, oldest first, with timestamps.
   * Readers backed by non-blocking IO return a promise (see
   * {@link PromptHistoryReader}); it rejects with
   * {@link PromptHistoryUnavailableError} when the primary store exists but
   * cannot be read, instead of reporting an empty history.
   */
  prompts(sessionId: string): P;
  /** Implementations must bound native IO before materializing prompt text. */
  recentPrompts?(sessionId: string, limit: number): Promise<SessionPrompt[]> | SessionPrompt[];
}

/** A history reader whose prompt read may be asynchronous (non-blocking IO). */
export type PromptHistoryReader = CopilotHistoryReader<
  Promise<SessionPrompt[]> | SessionPrompt[]
>;

/** The CLI store exists but prompt history could not be read right now. */
export class PromptHistoryUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PromptHistoryUnavailableError';
  }
}
