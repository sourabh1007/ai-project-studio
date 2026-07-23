import type { SessionStatus } from '../session/session-contract.js';
import type { CheckpointSummary } from '../copilot-history/copilot-history-contract.js';

/** Work recorded by the CLI for one session under a feature. */
export interface SessionWorkSummary {
  sessionId: string;
  prompt: string;
  status: SessionStatus;
  createdAt: string;
  /** The CLI's own one-line session summary, if any. */
  summary: string | null;
  checkpoints: CheckpointSummary[];
}

/** Aggregated, read-only view of everything done across a feature's sessions. */
export interface FeatureWorkSummary {
  featureId: string;
  /** Dev sessions, newest first. */
  sessions: SessionWorkSummary[];
}

export interface FeatureWorkSummaryService {
  getByFeature(featureId: string): FeatureWorkSummary;
}
