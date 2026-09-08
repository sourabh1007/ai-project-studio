import type { SessionKind } from '../provider/provider-contract.js';
import type { UsageEvent } from './usage-contract.js';

/** A UsageEvent enriched with computed credits and its session kind. */
export interface StoredUsage extends UsageEvent {
  credits: number;
  kind: SessionKind;
}

/** Indexed sink lookup for bounded reconciliation of durable capture payloads. */
export interface UsageLookup {
  get(sessionId: string, turnIndex: number): StoredUsage | null;
}

/** Persistence port for usage events. Implemented by the persistence module. */
export interface UsageRepo {
  /** Insert or update usage events, keyed by (sessionId, turnIndex). */
  saveAll(events: StoredUsage[]): void;
  listBySession(sessionId: string): StoredUsage[];
  deleteBySession(sessionId: string): void;
}
