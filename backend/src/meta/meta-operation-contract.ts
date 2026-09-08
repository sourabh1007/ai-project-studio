import type { MetaRequest, MetaRunResult, MetaResultTransport, MetaUsageSnapshot } from './meta-runner.js';
import type { PersistedMetaUsage } from './meta-usage-contract.js';

export type MetaOperationState = 'pending' | 'running' | 'interrupted' | 'failed' | 'completed';
export type MetaOperationOutcome = 'not-dispatched' | 'unknown' | 'returned';
export type MetaOperationUsageState = 'unknown' | 'unsupported' | 'partial' | 'recorded';

export interface MetaOperationStart {
  providerId?: string;
  requestedModel?: string;
  providerSessionId?: string | null;
  transport?: MetaResultTransport;
}

export interface MetaOperationRequest extends MetaRequest {
  /** Stamped by the recording wrapper; native owners must never substitute a provider/session ID. */
  operationId?: string;
  automationId?: string;
  originSessionId?: string;
  onStart?: (sessionId: string, attribution?: MetaOperationStart) => void;
}

export interface MetaOperation {
  operationId: string;
  featureId: string;
  automationId: string | null;
  originSessionId: string | null;
  providerId: string | null;
  requestedModel: string | null;
  resolvedModel: string | null;
  sessionId: string | null;
  providerSessionId: string | null;
  sessionIds: string[];
  transport: MetaResultTransport | 'unknown';
  state: MetaOperationState;
  outcome: MetaOperationOutcome;
  purpose: string | null;
  label: string | null;
  resultText: string | null;
  errorMessage: string | null;
  usageState: MetaOperationUsageState;
  usage: MetaUsageSnapshot | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface MetaOperationScope {
  operationId: string;
  featureId: string;
  automationId: string | null;
  originSessionId: string | null;
}

export interface MetaOperationLease {
  readonly signal: AbortSignal;
  abort(): void;
  expectPhysicalOwnership(): void;
  /** Register a newly known application session before publishing its onStart callback. */
  linkSession(sessionId: string): void;
  /** Callback settlement is insufficient when provider termination is unconfirmed. */
  requireTerminationConfirmation(): void;
}

/**
 * Parent-owned admission and quiescence boundary. The entire callback, including
 * initial/terminal persistence, must remain owned until its promise settles.
 * Quiescing a scope closes admission before aborting and awaiting its work.
 */
export interface MetaOperationOwnership {
  own<T>(
    scope: MetaOperationScope,
    run: (lease: MetaOperationLease) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  quiesceFeature(featureId: string, timeoutMs: number): Promise<boolean>;
  quiesceSession(sessionId: string, timeoutMs: number): Promise<boolean>;
  quiesceAutomation(automationId: string, timeoutMs: number): Promise<boolean>;
  quiesceAll(timeoutMs: number): Promise<boolean>;
  /** Parent supplies actual operation-specific provider termination proof, never a timeout. */
  confirmTermination(operationId: string): void;
  unconfirmed(): Array<MetaOperationScope & { sessionIds: string[] }>;
}

export type MetaOperationPhysicalProof = 'not-started' | 'released' | 'exited' | 'unconfirmed';

/** One immutable native attempt, not a reusable provider-session identifier. */
export interface MetaOperationPhysicalOwner {
  readonly ownerId: string;
  readonly settled: Promise<Exclude<MetaOperationPhysicalProof, 'unconfirmed'>>;
  /**
   * Stops only this attempt. A quarantined attempt requires native exit;
   * released means a normal terminal response and safe lease release were observed.
   */
  quiesce(timeoutMs: number): Promise<MetaOperationPhysicalProof>;
}

/** Registration must occur before enqueue/acquire/bootstrap/dispatch can escape. */
export interface MetaOperationPhysicalOwnership {
  register(operationId: string, owner: MetaOperationPhysicalOwner): void;
  /** Missing attribution is unknown, never evidence of physical completion. */
  quiesce(operationId: string, timeoutMs: number): Promise<'confirmed' | 'unconfirmed' | 'unknown'>;
}

export interface ManagedMetaOperationPhysicalOwnership extends MetaOperationPhysicalOwnership {
  newOwnerId(): string;
  begin(operationId: string): void;
  expect(operationId: string): void;
  seal(operationId: string): Promise<'confirmed' | 'unknown'>;
  /** Called only after operation-specific or global native completion proof. */
  forget(operationId: string): void;
}

export type MetaOperationPhysicalRegistration = Pick<ManagedMetaOperationPhysicalOwnership, 'register' | 'newOwnerId'>;

export interface MetaOperationPage {
  items: MetaOperation[];
  nextCursor: string | null;
}

export type MetaOperationSummary = Omit<MetaOperation, 'resultText'> & { hasResult: boolean };

export interface MetaOperationFilter {
  featureId?: string;
  sessionId?: string;
  automationId?: string;
}

export interface MetaOperationSummaryPage {
  items: MetaOperationSummary[];
  nextCursor: string | null;
}

export interface MetaOperationRepo {
  create(operation: MetaOperation): void;
  get(operationId: string): MetaOperation | null;
  /** Updates only an existing unfinished operation; never recreates deleted rows. */
  update(operation: MetaOperation): boolean;
  /** Atomically commits full result and compatibility usage metadata before publication. */
  complete(operation: MetaOperation, usage: PersistedMetaUsage | null): boolean;
  listUnfinishedPage(afterOperationId: string | null, limit: number): MetaOperationPage;
  listPage(filter: MetaOperationFilter, afterOperationId: string | null, limit: number): MetaOperationSummaryPage;
  deleteByFeature(featureId: string): void;
  deleteBySession(sessionId: string): void;
  deleteByAutomation(automationId: string): void;
}

export interface RecordedMetaRunResult extends MetaRunResult {
  operationId: string;
}
