import type { MetaOperationRepo, MetaOperationSummary } from './meta-operation-contract.js';
import type { MetaUsageSnapshot } from './meta-runner.js';
import type { UsageCaptureRead } from '../usage/usage-capture-contract.js';

export interface MetaUsageCaptureRepo extends Pick<MetaOperationRepo, 'listPage'> {
  refreshUsage(operationId: string, usage: MetaUsageSnapshot, capturedAt: string): boolean;
}

export type MetaUsageEventMap = {
  'meta.usage.updated': { featureId: string; operationId: string };
};

export interface MetaUsageCaptureDeps {
  operations: MetaUsageCaptureRepo;
  read(sessionId: string, operation: MetaOperationSummary, cursor: string | null, limit: number): UsageCaptureRead;
  now(): string;
  onChanged(operation: MetaOperationSummary): void;
  pageSize: number;
  maxPages: number;
}

/**
 * Bounded repeated scans reconcile late vendor charges and corrections, including
 * failed attempts. Replace snapshots, never add them to previously captured sums.
 * No rows or an unavailable source is unknown usage, not a zero-cost operation.
 */
export function createMetaUsageCapture(deps: MetaUsageCaptureDeps) {
  let after: string | null = null;
  let active: {
    operation: MetaOperationSummary; next: string | null; sessions: string[];
    index: number; cursor: string | null; seen: boolean; sessionSeen: boolean;
    inputTokens: number; outputTokens: number; nanoAiu: number;
  } | null = null;
  return {
    tick(): void {
      for (let page = 0; page < deps.maxPages; page += 1) {
        if (!active) {
          const result = deps.operations.listPage({}, after, 1);
          const operation = result.items[0];
          if (!operation) { after = null; return; }
          const sessions = operation.transport === 'warm-acp'
            ? operation.providerSessionId ? [operation.providerSessionId] : []
            : [...new Set([...operation.sessionIds, ...(operation.sessionId ? [operation.sessionId] : [])])];
          active = {
            operation, next: result.nextCursor, sessions, index: 0, cursor: null,
            seen: false, sessionSeen: false, inputTokens: 0, outputTokens: 0, nanoAiu: 0,
          };
        }
        const current = active;
        const sessionId = current.sessions[current.index];
        if (sessionId) {
          const result = deps.read(sessionId, current.operation, current.cursor, deps.pageSize);
          if (result.status !== 'ready' || result.issue) {
            // Retry from the beginning next sweep; partial scans are not totals.
            after = current.next; active = null;
            if (after === null) return;
            continue;
          }
          for (const { event } of result.rows) {
            current.inputTokens += event.inputTokens;
            current.outputTokens += event.outputTokens;
            current.nanoAiu += event.nanoAiu;
            current.seen = true;
            current.sessionSeen = true;
          }
          current.cursor = result.nextCursor;
          if (current.cursor !== null) continue;
          if (!current.sessionSeen) {
            after = current.next; active = null;
            if (after === null) return;
            continue;
          }
          current.index += 1;
          current.sessionSeen = false;
          if (current.index < current.sessions.length) continue;
        }
        if (current.seen) {
          const usage = {
            inputTokens: current.inputTokens, outputTokens: current.outputTokens,
            nanoAiu: current.nanoAiu, credits: current.nanoAiu / 1_000_000_000,
          };
          if (deps.operations.refreshUsage(current.operation.operationId, usage, deps.now())) {
            deps.onChanged(current.operation);
          }
        }
        after = current.next;
        active = null;
        if (after === null) return;
      }
    },
  };
}
