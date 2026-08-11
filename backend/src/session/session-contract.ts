import type { SessionKind } from '../provider/provider-contract.js';

export type { SessionKind };

/**
 * Controls whether a persisted session belongs to the user-facing feature
 * timeline. Internal sessions still use `kind` for usage accounting.
 */
export type SessionScope = 'feature' | 'internal';

/** Lifecycle status of a session. */
export type SessionStatus =
  | 'created'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** A persisted AI session belonging to a feature. */
export interface Session {
  id: string;
  featureId: string;
  /** User-editable display name; null falls back to the ordinal label. */
  name: string | null;
  provider: string;
  /** Model requested by the user (may be 'auto'). */
  requestedModel: string;
  /** Model actually used, discovered from usage telemetry; null until known. */
  resolvedModel: string | null;
  status: SessionStatus;
  kind: SessionKind;
  /** Defaults to `feature` for records created before scoped sessions. */
  scope?: SessionScope;
  /** Container group within the feature; null = directly under the feature. */
  groupId?: string | null;
  /** Sort position within its container (the feature root or a group). */
  orderIndex?: number;
  prompt: string;
  /** Read-side fallback title derived from CLI history when prompt is empty. */
  workTitle?: string | null;
  /** Absolute/relative path of this session's OTel usage file. */
  usageFilePath: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
}

/** Request to start a new session under a feature. */
export interface StartSessionRequest {
  featureId: string;
  providerId?: string;
  model?: string;
  prompt: string;
  /** Absolute paths attached to the provider's initial prompt. */
  attachments?: readonly string[];
  kind?: SessionKind;
  scope?: SessionScope;
  cwd?: string;
  /** Restrict the run to zero tools (pure prompt→text completion). */
  noTools?: boolean;
}
