import type { SessionSummary } from './session-summary-contract.js';

/**
 * Port for persisting and retrieving per-session summaries. Implemented by the
 * persistence module; the session-summary runner depends only on this interface.
 */
export interface SessionSummaryStore {
  save(summary: SessionSummary): void;
  load(sessionId: string): SessionSummary | null;
  delete(sessionId: string): void;
}
