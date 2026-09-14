export interface PersistedMetaUsage {
  sessionId: string;
  featureId: string;
  providerId: string;
  requestedModel: string;
  resolvedModel: string | null;
  transport: 'warm-acp';
  providerSessionId: string | null;
  purpose: string | null;
  label: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  nanoAiu: number | null;
  credits: number | null;
  capturedAt: string;
}

export interface MetaUsageRepo {
  get(sessionId: string): PersistedMetaUsage | null;
  save(record: PersistedMetaUsage): void;
  /** Most-recent warm-ACP usage snapshots, newest first, for the IDE activity
   * feed (what model ran, why, and how many credits it burned). */
  listRecent(limit: number): PersistedMetaUsage[];
  deleteByFeature(featureId: string): void;
  deleteBySession(sessionId: string): void;
}
