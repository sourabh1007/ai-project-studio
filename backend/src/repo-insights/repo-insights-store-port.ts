import type { RepoInsights } from './repo-insights-contract.js';

/**
 * Persistence port for a repository's last completed insights snapshot. Unlike
 * the in-process cache, this survives app/backend restarts: once a repository
 * has been scanned its snapshot is restored instantly on every later open.
 */
export interface RepoInsightsStore {
  /** The stored snapshot for a repository, or `null` when never scanned. */
  get(repositoryId: string): RepoInsights | null;
  /** Persists (replacing) the latest completed snapshot for a repository. */
  save(insights: RepoInsights): void;
  /** Forgets the stored snapshot for a repository. */
  delete(repositoryId: string): void;
}
