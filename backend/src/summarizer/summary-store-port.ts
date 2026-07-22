import type { FeatureSummary } from './summarizer-contract.js';

/**
 * Port for persisting and retrieving feature summaries. Implemented by the
 * persistence module; the summarizer depends only on this interface.
 */
export interface SummaryStore {
  save(summary: FeatureSummary): void;
  load(featureId: string): FeatureSummary | null;
  delete(featureId: string): void;
}
