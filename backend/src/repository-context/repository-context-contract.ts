/** Lifecycle of the generated understanding for a repository checkout. */
export type RepositoryContextStatus =
  | 'pending'
  | 'generating'
  | 'ready'
  | 'stale'
  | 'failed';

/** Progress state of one discrete repository-analysis step. */
export type RepositoryContextStepStatus =
  | 'pending'
  | 'running'
  | 'ok'
  | 'failed'
  | 'skipped';

/**
 * One tracked stage of the context pipeline. Steps run in order; a failed step
 * carries the underlying error in `detail` and later steps become `skipped`, so
 * the UI can show exactly where generation stopped.
 */
export interface RepositoryContextStep {
  key: string;
  label: string;
  status: RepositoryContextStepStatus;
  detail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Failure surfaced when the latest context generation attempt did not succeed. */
export interface RepositoryContextFailure {
  code: string;
  message: string;
  failedAt: string;
  retryable: boolean;
  /** Key of the pipeline step that failed, or null for pre-pipeline failures. */
  step: string | null;
}

/** Timestamps for creation and the latest generation lifecycle transitions. */
export interface RepositoryContextTimestamps {
  createdAt: string;
  updatedAt: string;
  generationStartedAt: string | null;
  generatedAt: string | null;
}

/**
 * Persisted repository understanding. A stale or failed record may retain the
 * last successful content for inspection, but only `ready` is launch-safe.
 */
export interface RepositoryContext {
  repositoryId: string;
  status: RepositoryContextStatus;
  content: string | null;
  sourceRevision: string | null;
  timestamps: RepositoryContextTimestamps;
  /** Per-step progress of the most recent generation attempt. */
  steps: RepositoryContextStep[];
  failure: RepositoryContextFailure | null;
}

/** A bounded text file collected as repository evidence. */
export interface RepositoryEvidenceFile {
  path: string;
  content: string;
}

/** Provider-neutral, bounded source material used to generate context. */
export interface RepositoryEvidence {
  sourceRevision: string;
  tree: string;
  files: RepositoryEvidenceFile[];
  totalFileCount: number;
  omittedFileCount: number;
  totalContentChars: number;
  largeRepository: boolean;
}

/** Raw tracked text supplied to the pure evidence selector. */
export interface RepositoryEvidenceCandidate extends RepositoryEvidenceFile {
  sizeBytes: number;
}

