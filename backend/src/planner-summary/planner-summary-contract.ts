/** The time span a planner summary covers, anchored on a calendar day. */
export type PlannerSummaryScope = 'day' | 'month' | 'year';

/** A request to summarize the planner tasks within a scope around a date. */
export interface PlannerSummaryRequest {
  /** Whether to summarize the anchor day, its month, or its year. */
  scope: PlannerSummaryScope;
  /** `YYYY-MM-DD` anchor; its day/month/year selects the tasks in scope. */
  date: string;
  /** Free-text guidance steering the summary (may be empty). */
  prompt: string;
  /** Aborts the underlying meta session when the caller cancels. */
  signal?: AbortSignal;
}

/** The AI-generated summary of a scope of planner tasks. */
export interface PlannerSummaryResult {
  scope: PlannerSummaryScope;
  date: string;
  /** Human-readable label for the summarized range (e.g. `2026-02`). */
  range: string;
  content: string;
  /** How many tasks fed the summary. */
  taskCount: number;
  createdAt: string;
}

/** Produces an AI summary of a scope of planner tasks. */
export interface PlannerSummarizer {
  summarize(request: PlannerSummaryRequest): Promise<PlannerSummaryResult>;
}
