import type { MetaOperationRepo, MetaOperationSummary } from './meta-operation-contract.js';
import type { MetaUsageSnapshot } from './meta-runner.js';
import type { UsageCaptureRead } from '../usage/usage-capture-contract.js';

export interface MetaUsageCaptureRepo extends Pick<MetaOperationRepo, 'listPage'> {
  getSummary(operationId: string): MetaOperationSummary | null;
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
  type ActiveCapture = {
    operation: MetaOperationSummary; next: string | null; sessions: string[];
    index: number; cursor: string | null; seen: boolean; sessionSeen: boolean;
    inputTokens: number; outputTokens: number; nanoAiu: number | null;
    retries: number; retry: boolean;
  };
  let active: ActiveCapture | null = null;
  const priority = new Map<string, number>();
  let priorityActive: ActiveCapture | null = null;
  let priorityTurn = true;
  return {
    /** Lifecycle hints outrank historical repair without allowing an unbounded queue. */
    prioritize(operationId: string): void {
      priority.delete(operationId);
      if (priority.size >= 256) priority.delete(priority.keys().next().value!);
      priority.set(operationId, 3);
    },
    tick(): void {
      for (let page = 0; page < deps.maxPages; page += 1) {
        const prioritized = priorityTurn && (priorityActive !== null || priority.size > 0);
        priorityTurn = !prioritized;
        const historical = active;
        if (prioritized) active = priorityActive;
        if (!active) {
          const id = prioritized ? [...priority.keys()].at(-1)! : null;
          const retries = id === null ? 0 : priority.get(id)!;
          if (id !== null) priority.delete(id);
          const saved = id === null ? null : deps.operations.getSummary(id);
          const result = prioritized
            ? { items: saved ? [saved] : [], nextCursor: null }
            : deps.operations.listPage({}, after, 1);
          const operation = result.items[0];
          if (!operation) {
            if (prioritized) { active = historical; continue; }
            after = null;
            return;
          }
          const sessions = operation.transport === 'warm-acp'
            ? operation.providerSessionId ? [operation.providerSessionId] : []
            : [...new Set([...operation.sessionIds, ...(operation.sessionId ? [operation.sessionId] : [])])];
          active = {
            operation, next: result.nextCursor, sessions, index: 0, cursor: null,
            seen: false, sessionSeen: false, inputTokens: 0, outputTokens: 0, nanoAiu: 0,
            retries, retry: false,
          };
        }
        const current = active;
        // All exits below settle this lane independently; history never waits
        // for a multi-page newly completed operation and vice versa.
        const settle = (): boolean => {
          if (prioritized) {
            if (active === null && current.retry && current.retries > 0 && priority.size < 256 && !priority.has(current.operation.operationId)) {
              priority.set(current.operation.operationId, current.retries - 1);
            }
            priorityActive = active;
            active = historical;
            return false;
          }
          return after === null;
        };
        const sessionId = current.sessions[current.index];
        if (sessionId) {
          const result = deps.read(sessionId, current.operation, current.cursor, deps.pageSize);
          if (result.status !== 'ready' || result.issue) {
            // Retry from the beginning next sweep; partial scans are not totals.
            current.retry = true;
            if (!prioritized) after = current.next;
            active = null;
            if (settle()) return;
            continue;
          }
          for (const { event } of result.rows) {
            current.inputTokens += event.inputTokens;
            current.outputTokens += event.outputTokens;
            current.nanoAiu = current.nanoAiu === null || event.nanoAiu === null ? null : current.nanoAiu + event.nanoAiu;
            current.seen = true;
            current.sessionSeen = true;
          }
          current.cursor = result.nextCursor;
          if (current.cursor !== null) { settle(); continue; }
          if (!current.sessionSeen) {
            current.retry = true;
            if (!prioritized) after = current.next;
            active = null;
            if (settle()) return;
            continue;
          }
          current.index += 1;
          current.sessionSeen = false;
          if (current.index < current.sessions.length) { settle(); continue; }
        }
        if (current.seen) {
          const usage = {
            inputTokens: current.inputTokens, outputTokens: current.outputTokens,
            nanoAiu: current.nanoAiu, credits: current.nanoAiu === null ? null : current.nanoAiu / 1_000_000_000,
          };
          if (deps.operations.refreshUsage(current.operation.operationId, usage, deps.now())) {
            deps.onChanged(current.operation);
          }
        }
        if (!prioritized) after = current.next;
        active = null;
        if (settle()) return;
      }
    },
  };
}
