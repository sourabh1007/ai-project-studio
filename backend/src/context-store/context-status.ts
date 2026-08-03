import type { ContextScope } from './context-contract.js';

/**
 * Lifecycle phase of an in-flight shared-context update. Surfaced to the UI so a
 * durable-but-invisible background merge (generate → save → live-push) shows an
 * animated indicator instead of appearing stuck. `idle` is the terminal frame
 * that tells the UI the flow finished (used to flash a brief "updated" state).
 */
export type ContextStatusPhase = 'generating' | 'saving' | 'sharing' | 'idle';

/** A single status frame emitted while a context document is being updated. */
export interface ContextStatus {
  scope: ContextScope;
  scopeId: string;
  phase: ContextStatusPhase;
}

/** Bus/stream event map contribution for context-status frames. */
export type ContextStatusEventMap = {
  'context.status': ContextStatus;
};
