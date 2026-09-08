import type { UsageEvent } from './usage-contract.js';
import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Bounded canonical ledger payload; it deliberately excludes provider raw data. */
export const usageCapturePayloadSchema: z.ZodType<UsageEvent> = z.object({
  sessionId: z.string().min(1).max(256), featureId: z.string().min(1).max(256),
  turnIndex: count, provider: z.string().min(1).max(256),
  requestedModel: z.string().max(1024), resolvedModel: z.string().max(1024),
  operation: z.string().max(256), inputTokens: count, outputTokens: count,
  reasoningOutputTokens: count, cost: z.number().finite().nonnegative(), nanoAiu: count,
  serviceRequestId: z.string().max(1024).nullable(),
  startedAt: z.string().min(1).max(128), endedAt: z.string().min(1).max(128),
});

export type UsageCaptureStatus = 'pending' | 'retrying' | 'unsupported' | 'complete';

export interface UsageCaptureState {
  sessionId: string;
  sourceId: string;
  /** Scan position, not proof of completeness; per-row acknowledgements are durable watermarks. */
  cursor: string | null;
  /** Independent bounded reconciliation position in the retained payload ledger. */
  replayCursor?: number | null;
  /** Durable proof and completion markers for one bounded reconciliation epoch. */
  finalScan?: boolean;
  replayClean?: boolean;
  /** Source scan reached EOF; does NOT imply authoritative provider finality. */
  sourceDone?: boolean;
  replayDone?: boolean;
  status: UsageCaptureStatus;
  reason: string | null;
}

export interface UsageCaptureRow {
  /** Provider-owned immutable request identity, not a position in a result set. */
  sourceKey: string;
  event: UsageEvent;
}

export type UsageCaptureRead =
  | {
      status: 'ready';
      sourceId: string;
      rows: UsageCaptureRow[];
      nextCursor: string | null;
      /** Incomplete rows can be revisited without starving later valid rows. */
      issue?: { status: 'retrying' | 'unsupported'; reason: string };
      /** Only an authoritative provider completion signal can assert this. */
      final: boolean;
    }
  | {
      status: 'retrying' | 'unsupported';
      sourceId: string;
      reason: string;
    };

export interface UsageCaptureIdentity {
  turnIndex: number;
  fingerprint: string | null;
  event: UsageEvent;
}

export interface UsageCaptureReplay {
  sourceKey: string;
  turnIndex: number;
  fingerprint: string | null;
  /** A legacy pre-payload ledger entry cannot invent its missing observation. */
  event: UsageEvent | null;
}

export interface UsageCapturePage {
  items: UsageCaptureState[];
  /** Last returned session ID when more rows remain; null ends this round. */
  nextCursor: string | null;
}

export class UsageCaptureIdentityError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

/**
 * Independently committed payload staging precedes usage; acknowledgement
 * follows usage. Payloads remain after acknowledgement to repair sink loss.
 * Implementations must reject rollbackable outer capture transactions.
 */
export interface UsageCaptureRepo {
  get(sessionId: string): UsageCaptureState | null;
  save(state: UsageCaptureState): void;
  listUnfinished(): UsageCaptureState[];
  /** Bounded keyset scan; resume null on the next recovery tick to begin a new round. */
  listUnfinishedPage(afterSessionId: string | null, limit: number): UsageCapturePage;
  reserve(sessionId: string, sourceKey: string, event: UsageEvent): UsageCaptureIdentity;
  listReplay(sessionId: string, afterTurnIndex: number | null, limit: number): UsageCaptureReplay[];
  acknowledge(sessionId: string, sourceKey: string, fingerprint: string): void;
  deleteBySession(sessionId: string): void;
}
