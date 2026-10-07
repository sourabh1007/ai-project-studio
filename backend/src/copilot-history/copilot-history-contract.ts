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
   * True for a synthetic, live "answering" row representing an in-flight turn
   * whose prompt/response text the CLI store has not persisted yet. Such a row
   * carries no `text`/`response` and exists only to show the assistant is
   * actively responding right now.
   */
  pending?: boolean;
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
  /** User-message rows for one session, ascending by turn index. */
  userMessages(sessionId: string): HistoryUserMessageRow[];
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
}

/**
 * Reads the most recent genuine (non-injected) user turn for a session from the
 * CLI's live event log. Isolated behind a port so the reader stays pure and the
 * filesystem tail-read is the only IO-aware piece.
 */
export interface LivePromptSource {
  /** The latest live turn for one session, or null when none is readable. */
  latest(sessionId: string): LivePromptTurn | null;
}

/** Aggregates raw CLI rows into per-session history. */
export interface CopilotHistoryReader {
  read(sessionIds: string[]): SessionHistory[];
  /** Every prompt the user sent in a session, oldest first, with timestamps. */
  prompts(sessionId: string): SessionPrompt[];
}
