import type { SessionKind } from '../provider/provider-contract.js';

export type { SessionKind };

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
  prompt: string;
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
  kind?: SessionKind;
  cwd?: string;
}
