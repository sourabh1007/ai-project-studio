/** An AI-generated summary of a single session's work. */
export interface SessionSummary {
  sessionId: string;
  content: string;
  createdAt: string;
}

export interface SummarizeSessionRequest {
  sessionId: string;
}

/**
 * Generates and retrieves a per-session summary. Generation spawns a silent
 * `meta` session (excluded from dev-cost rollups and hidden from the UI) that
 * summarizes just the one target session.
 */
export interface SessionSummarizer {
  summarize(request: SummarizeSessionRequest): Promise<SessionSummary>;
  get(sessionId: string): SessionSummary | null;
}
