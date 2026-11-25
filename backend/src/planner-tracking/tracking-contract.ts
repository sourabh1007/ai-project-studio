import type { PlannerTask } from '../planner/planner-contract.js';

export interface WorkEvidence {
  id: string;
  kind: 'prompt' | 'response' | 'agent' | 'skill' | 'pr';
  label: string;
  text: string;
  at: string;
  sessionId: string | null;
  /** Only a finished response/operation can support reported completion. */
  completed: boolean;
  truncated?: boolean;
}

export interface WorkSnapshot {
  featureId: string;
  repoId: string | null;
  name: string;
  evidence: WorkEvidence[];
}

export interface WorkProvenance {
  featureId: string;
  updatedAt: string;
  completion: 'requested-or-ongoing' | 'reported-complete';
  evidence: WorkEvidence[];
}

export type GeneratedFields = Pick<PlannerTask, 'title' | 'notes' | 'status'>;
export interface TrackedWork {
  key: string;
  taskId: string;
  repoId: string | null;
  generated: GeneratedFields;
  locked: (keyof GeneratedFields)[];
  provenance: WorkProvenance;
}
export interface TrackingCursor {
  fingerprint: string;
  retryAfter: number;
}
export type WorkCandidate = Pick<PlannerTask, 'id' | 'repoId' | 'title' | 'notes' | 'status' | 'prUrl' | 'sessionId'>;

export interface WorkTrackingStore {
  enabled(): boolean;
  setEnabled(value: boolean): void;
  cursor(featureId: string): TrackingCursor | null;
  saveCursor(featureId: string, value: TrackingCursor): void;
  candidates(repoId: string | null, featureId: string): {
    tasks: WorkCandidate[];
    work: { key: string; taskId: string; title: string; deleted: boolean; prUrl: string | null }[];
  };
  get(key: string): TrackedWork | null;
  save(work: TrackedWork): void;
  provenance(taskId: string): WorkProvenance | null;
  atomic(run: () => void): void;
}

export interface WorkTrackingSource {
  page(after: string, since: string): string[];
  read(featureId: string, signal: AbortSignal): Promise<WorkSnapshot | null>;
  exists(featureId: string, repoId: string | null): boolean;
}

export interface WorkTrackingJob {
  featureId: string;
  workspaceName: string;
  repositoryName: string | null;
  queuedAt: string;
  startedAt: string | null;
  phase: 'queued' | 'reading' | 'analyzing' | 'retry-wait';
  retryAt: string | null;
  evidenceCount: number | null;
  sessionCount: number | null;
}

export interface WorkTrackingResult {
  job: WorkTrackingJob;
  finishedAt: string;
  outcome: 'updated' | 'unchanged' | 'no-evidence' | 'unavailable' | 'retry-wait' | 'failed' | 'cancelled';
  taskCount: number | null;
}

export interface WorkTrackingStatus {
  enabled: boolean;
  running: boolean;
  queued: number;
  lastUpdatedAt: string | null;
  error: string | null;
  jobs: WorkTrackingJob[];
  currentJob: WorkTrackingJob | null;
  lastRun: WorkTrackingResult | null;
  pollIntervalMs: number;
}

export interface WorkTracker {
  notify(featureId: string): void;
  status(): WorkTrackingStatus;
  setEnabled(enabled: boolean): WorkTrackingStatus;
  tick(signal: AbortSignal): Promise<void>;
  stop(): void;
}
