export type SkillOrigin = 'repository' | 'ide' | 'cli' | 'unknown';
export type SkillUsageKind = 'invocation' | 'context-prepared' | 'context-injected';

export interface SkillUsageRecord {
  eventId: string;
  featureId: string;
  sessionId: string;
  provider: string;
  repoId: string | null;
  identity: string;
  name: string;
  source: SkillOrigin;
  kind: SkillUsageKind;
  scope: 'feature' | 'internal';
  inputTokens: number | null;
  outputTokens: number | null;
  nanoAiu: number | null;
  recordedAt: string;
}

export interface SkillUsageRow {
  identity: string;
  name: string;
  source: SkillOrigin;
  kind: SkillUsageKind;
  provider: string;
  repoId: string | null;
  repoName: string | null;
  uses: number;
  sessions: number;
  inputTokens: number | null;
  outputTokens: number | null;
  nanoAiu: number | null;
  reportedInput: number;
  reportedOutput: number;
  reportedAic: number;
  lastUsedAt: string;
}

export interface SkillUsageFilter {
  scope: 'feature' | 'internal';
  featureId?: string;
}

export interface SkillUsageSnapshot {
  rows: SkillUsageRow[];
  limited: boolean;
  maxEvents: number;
}

export interface SkillUsageRepo {
  /** Durable identities make historical/live replays idempotent. */
  record(entry: SkillUsageRecord): void;
  read(filter: SkillUsageFilter, maxEvents: number): SkillUsageSnapshot;
}
