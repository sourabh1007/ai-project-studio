import type { Feature } from '../feature/feature-contract.js';
import type { Session } from '../session/session-contract.js';
import type { Transcript } from '../session/transcript-capture.js';

/** A source session paired with its captured transcript (if any). */
export interface SessionTranscript {
  session: Session;
  transcript: Transcript | null;
}

/** All material needed to summarize a feature: the feature and its sessions. */
export interface FeatureTranscripts {
  feature: Feature;
  sessions: SessionTranscript[];
}

/** The AI-generated cross-session summary of a feature. */
export interface FeatureSummary {
  featureId: string;
  content: string;
  createdAt: string;
}

export interface SummarizeRequest {
  featureId: string;
}

/** Produces and persists an AI summary of a feature's sessions. */
export interface FeatureSummarizer {
  summarize(request: SummarizeRequest): Promise<FeatureSummary>;
}
