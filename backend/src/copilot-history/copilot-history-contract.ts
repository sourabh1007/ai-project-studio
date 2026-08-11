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
}

/** Aggregates raw CLI rows into per-session history. */
export interface CopilotHistoryReader {
  read(sessionIds: string[]): SessionHistory[];
}
