/** Ports and types for durable client operation keys. */

export type ClientOperationState = 'pending' | 'succeeded';

export interface ClientOperationRecord {
  scope: string;
  key: string;
  requestHash: string;
  state: ClientOperationState;
  status: number | null;
  responseJson: string | null;
}

export interface ClientOperationRepo {
  get(scope: string, key: string): ClientOperationRecord | undefined;
  /** Atomically claims the key; false when a record already exists. */
  reservePending(scope: string, key: string, requestHash: string, nowMs: number): boolean;
  /** Marks a pending record succeeded; false when it was not pending. */
  complete(scope: string, key: string, status: number, responseJson: string, nowMs: number): boolean;
  /** Removes a record only while it is still pending with this request hash. */
  releasePending(scope: string, key: string, requestHash: string): void;
  count(): number;
  /** Removes at most `limit` succeeded records last updated before `cutoffMs`. */
  pruneSucceeded(cutoffMs: number, limit: number): number;
}

export interface OperationResult {
  status: number;
  body: unknown;
}

/**
 * Runs the final resource write and the success record in one atomic unit.
 * `write` must be synchronous and must not await.
 */
export type OperationCommit = (write: () => OperationResult) => OperationResult;

export interface ClientOperationRequest {
  /** Names the operation and its parent resource, e.g. `agent.attach:<featureId>`. */
  scope: string;
  /** Opaque client key; null runs the operation without idempotency. */
  key: string | null;
  /** Everything that defines the request; differing input under one key conflicts. */
  fingerprint: unknown;
}

export interface ClientOperations {
  /** Reads and validates the operation key header: a key, or null when absent. */
  keyFrom(headers: Record<string, string | string[] | undefined> | undefined): string | null;
  run(
    request: ClientOperationRequest,
    execute: (commit: OperationCommit) => Promise<unknown>,
  ): Promise<OperationResult>;
}

export const OPERATION_KEY_CONFLICT = 'operation_key_conflict';
export const OPERATION_PENDING = 'operation_pending';
export const OPERATION_CAPACITY = 'operation_capacity';
export const OPERATION_UNHEALTHY = 'operation_connection_unhealthy';
