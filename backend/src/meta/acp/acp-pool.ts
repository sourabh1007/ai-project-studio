import type { AcpTurnRequest, AcpTurnResult } from './acp-client.js';
import { MetaAbortError } from '../meta-runner.js';
import type { MetaOperationPhysicalProof, MetaOperationPhysicalRegistration } from '../meta-operation-contract.js';
import { ProcessAdmissionError, type ProcessAdmission, type ProcessPermit, type QueuePermit } from '../../kernel/process-admission.js';

export class MetaPoolCloseError extends AggregateError {
  constructor(errors: unknown[]) {
    super(errors, 'ACP process termination requests failed');
    this.name = 'MetaPoolCloseError';
  }
}

/**
 * The subset of {@link AcpClient} the pool depends on. Keeping it as a port lets
 * the pool be unit-tested against a fake client with no real process.
 */
export interface PooledClient {
  /** Performs the one-time ACP handshake. */
  initialize(): Promise<void>;
  /** Runs a single prompt turn on a warm session. */
  runTurn(request: AcpTurnRequest): Promise<AcpTurnResult>;
  /** Registers a callback fired when the underlying process exits. */
  onExit(handler: () => void): void;
  /** Cancels/kills the process so it can no longer be reused. */
  dispose(): void;
  /** True until the underlying process has exited. */
  readonly alive: boolean;
  /** True while the client may safely be leased for another warm turn. */
  readonly reusable: boolean;
}

export interface MetaSessionPoolConfig {
  physicalOwnership?: MetaOperationPhysicalRegistration;
  processAdmission?: ProcessAdmission;
  /** Number of warm sessions to keep ready. */
  size: number;
  /** Creates a fresh, un-initialized client (spawns a real ACP process). */
  createClient: () => PooledClient;
  /** Clock for session timestamps; defaults to `Date.now`. */
  now?: () => number;
  /** Delay before retrying a failed replenish attempt. */
  replenishDelayMs?: number;
  /** How long to wait for a disposed client to confirm exit before giving up. */
  terminationGraceMs?: number;
}

/** Lifecycle state of a single warm session. */
export type MetaSessionState = 'warming' | 'idle' | 'busy';

/** One warm turn a session served — the evidence behind its usage history. */
export interface MetaSessionTurn {
  /** Epoch ms the turn completed. */
  at: number;
  /**
   * Routing purpose the turn served — the "where in the IDE" signal (e.g.
   * `general`, `pr-review`, `self-recovery`). Defaults to `general`.
   */
  purpose: string;
  /**
   * Short, human-readable description of the concrete work the turn performed
   * (e.g. "PR review · change graph", "Repository analysis"). Lets the UI show
   * *what* the session was used for; absent for turns whose caller supplied no
   * label, where the UI falls back to the purpose.
   */
  label?: string;
  /** Input tokens the turn consumed, or 0 when the CLI reported none. */
  inputTokens: number;
  /** Output tokens the turn produced, or 0 when the CLI reported none. */
  outputTokens: number;
  /**
   * A capped preview of the inline prompt the IDE sent for this turn, so the UI
   * can show the actual conversation it drove. Absent when the prompt was empty.
   */
  prompt?: string;
  /**
   * A capped preview of the assistant text this turn streamed back. Absent when
   * the turn produced no streamed text.
   */
  response?: string;
}

/**
 * The turn a warm session is running *right now*: the inline prompt the IDE
 * sent and the assistant text streamed back so far. Present only while the
 * session is busy serving a turn, so the UI can open a live view of the actual
 * conversation flowing through the session instead of just a busy indicator.
 */
export interface MetaSessionLiveTurn {
  /** Routing purpose the in-flight turn serves. */
  purpose: string;
  /** Human-readable description of the in-flight work, when the caller set one. */
  label?: string;
  /** The full inline prompt the IDE sent for this turn (the IDE → AI side). */
  prompt: string;
  /** Assistant text streamed back so far; grows as the turn runs (AI → IDE). */
  response: string;
  /** Epoch ms the turn began running. */
  startedAt: number;
}

/** Live status of one warm session, for per-session status surfaces. */
export interface MetaSessionInfo {
  /** Stable id within the pool's lifetime (e.g. `s1`, `s2`). */
  id: string;
  /** What the session is doing right now. */
  state: MetaSessionState;
  /** Warm turns this specific session has served. */
  served: number;
  /** Epoch ms when the session began booting. */
  startedAt: number;
  /** Epoch ms of the most recent lease/turn, or null if never used. */
  lastActiveAt: number | null;
  /** Cumulative input tokens across every turn this session served. */
  inputTokens: number;
  /** Cumulative output tokens across every turn this session served. */
  outputTokens: number;
  /**
   * Most recent turns this session served (oldest first, newest last), capped
   * to a bounded window. Each entry records where it was used and its tokens,
   * so the UI can show a real usage history for the session.
   */
  history: MetaSessionTurn[];
  /**
   * The turn the session is running right now (prompt + streamed response).
   * Present only while the session is actively serving a turn; absent when
   * idle, warming, or leased without a running turn. Lets the UI show the live
   * conversation for a busy session.
   */
  live?: MetaSessionLiveTurn;
}

/** Live warm-capacity snapshot for a single pool. */
export interface MetaSessionPoolStats {
  /** Target remains saved, but shared admission currently prevents filling it. */
  waitingForCapacity?: boolean;
  /** Target number of warm sessions. */
  size: number;
  /** Sessions currently booted (idle + busy). */
  live: number;
  /** Sessions ready to lease right now. */
  idle: number;
  /** Sessions currently serving a turn. */
  busy: number;
  /** True once at least one session is ready to serve a turn. */
  ready: boolean;
  /**
   * Cumulative count of warm turns successfully served since the pool started.
   * A climbing value is live evidence that the IDE is really leasing warm
   * sessions (rather than cold-spawning a CLI per request).
   */
  served: number;
  /** Per-session live status, ordered by creation. */
  sessions: MetaSessionInfo[];
}

interface Waiter {
  resolve: (lease: PooledClientLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface PooledClientLease {
  readonly client: PooledClient;
  readonly id: number;
}

interface SessionRecord {
  processPermit?: ProcessPermit;
  /** Creation order, used for stable sorting. */
  seq: number;
  id: string;
  state: MetaSessionState;
  active: boolean;
  disposeOnRelease: boolean;
  leaseId: number | null;
  served: number;
  startedAt: number;
  lastActiveAt: number | null;
  inputTokens: number;
  outputTokens: number;
  history: MetaSessionTurn[];
  live: MetaSessionLiveTurn | null;
}

/** Longest per-session usage history retained (older turns are dropped). */
const MAX_HISTORY = 25;

/** Longest inline-prompt preview retained per historical turn. */
const MAX_TURN_PROMPT_CHARS = 2000;

/** Longest streamed-response preview retained per historical turn. */
const MAX_TURN_RESPONSE_CHARS = 12000;
const DEFAULT_REPLENISH_DELAY_MS = 1_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;

/** Truncates `text` to `max` characters, marking any elision with an ellipsis. */
function preview(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Context a caller attaches to a warm turn so its usage can be attributed. */
export interface MetaTurnContext {
  operationId?: string;
  /** Routing purpose the turn is serving (its "where in the IDE"). */
  purpose?: string;
  /** Human-readable description of the concrete work the turn performs. */
  label?: string;
}

/**
 * A small pool of warm `copilot --acp` sessions. Each client boots once
 * (`initialize`) and thereafter serves many cheap turns, so the two parallel
 * review steps and lazy file-explanation clicks lease a ready session instead
 * of paying CLI startup per request. Dead clients are replaced automatically to
 * keep {@link MetaSessionPoolConfig.size} sessions warm.
 */
export class MetaSessionPool {
  private readonly idle: PooledClient[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly records = new Map<PooledClient, SessionRecord>();
  private readonly physicalExits = new Map<PooledClient, Set<() => void>>();
  private readonly closeWaiters = new Set<(closed: boolean) => void>();
  private servedCount = 0;
  private seq = 0;
  private leaseSeq = 0;
  private closed = false;
  private spawning = false;
  private replenishTimer: ReturnType<typeof setTimeout> | null = null;
  private targetSize: number;
  private readonly now: () => number;
  private readonly replenishDelayMs: number;
  private readonly terminationGraceMs: number;
  private detachAdmission?: () => void;

  constructor(private readonly config: MetaSessionPoolConfig) {
    this.now = config.now ?? (() => Date.now());
    this.targetSize = Math.max(0, Math.floor(config.size));
    this.replenishDelayMs = Math.max(
      0,
      Math.floor(config.replenishDelayMs ?? DEFAULT_REPLENISH_DELAY_MS),
    );
    this.terminationGraceMs = Math.max(
      1,
      Math.floor(config.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS),
    );
    this.detachAdmission = config.processAdmission?.onCapacityChange(() => this.ensureTargetSize());
  }

  /** Warms available capacity; shared admission may leave part of the target unfilled. */
  async start(): Promise<void> {
    while (!this.closed && this.capacityCount() < this.targetSize) {
      if (!await this.spawn({ throwOnFailure: true, continueAfterSuccess: false })) break;
    }
  }

  /** Leases a warm session, waiting for one to free up if all are busy. */
  acquire(signal?: AbortSignal): Promise<PooledClientLease> {
    if (this.closed) {
      return Promise.reject(new Error('MetaSessionPool is closed'));
    }
    if (signal?.aborted) {
      return Promise.reject(
        new MetaAbortError({
          kind: 'aborted',
          termination: 'not-started',
        }),
      );
    }
    const ready = this.idle.shift();
    if (ready) {
      return Promise.resolve(this.markBusy(ready));
    }
    return new Promise((resolve, reject) => {
      let queue: QueuePermit | undefined;
      const waiter: Waiter = {
        resolve: (lease) => { queue?.release(); resolve(lease); },
        reject: (error) => { queue?.release(); reject(error); },
        signal,
      };
      queue = this.config.processAdmission?.reserveQueue(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        if (signal && waiter.onAbort) signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(new ProcessAdmissionError('closed'));
      });
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) {
            this.waiters.splice(index, 1);
          }
          waiter.reject(
            new MetaAbortError({
              kind: 'aborted',
              termination: 'not-started',
            }),
          );
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** Returns a leased session to the pool (or discards it if it has died). */
  release(lease: PooledClientLease): void {
    this.checkIn(lease);
  }

  /** Convenience: leases a session, runs one turn, and releases it. */
  async run(
    request: AcpTurnRequest,
    context?: MetaTurnContext,
  ): Promise<AcpTurnResult> {
    const physical = this.config.physicalOwnership;
    if (!context?.operationId || !physical) return this.runAttempt(request, context);
    const controller = new AbortController();
    let lease: PooledClientLease | null = null;
    let dispatched = false;
    let proof: Exclude<MetaOperationPhysicalProof, 'unconfirmed'> | null = null;
    let resolve!: (value: Exclude<MetaOperationPhysicalProof, 'unconfirmed'>) => void;
    const settled = new Promise<Exclude<MetaOperationPhysicalProof, 'unconfirmed'>>((done) => { resolve = done; });
    const finish = (value: Exclude<MetaOperationPhysicalProof, 'unconfirmed'>) => {
      if (proof !== null) return;
      proof = value;
      if (lease) {
        const listeners = this.physicalExits.get(lease.client);
        listeners?.delete(onExit);
        if (listeners?.size === 0) this.physicalExits.delete(lease.client);
      }
      resolve(value);
    };
    const onExit = () => finish('exited');
    physical.register(context.operationId, {
      ownerId: physical.newOwnerId(), settled,
      quiesce: async () => {
        if (proof !== null) return proof;
        controller.abort();
        if (lease && dispatched) {
          const record = this.records.get(lease.client);
          if (record && (!record.active || record.leaseId === lease.id)) this.deactivate(lease.client, true);
        }
        return proof ?? 'unconfirmed';
      },
    });
    const abort = () => controller.abort();
    if (request.signal?.aborted) abort();
    else request.signal?.addEventListener('abort', abort, { once: true });
    try {
      return await this.runAttempt({ ...request, signal: controller.signal }, context, {
        acquired: (value) => {
          lease = value;
          const listeners = this.physicalExits.get(value.client) ?? new Set<() => void>();
          listeners.add(onExit);
          this.physicalExits.set(value.client, listeners);
        },
        dispatched: () => { dispatched = true; },
        released: (responded) => {
          if (!dispatched) finish('not-started');
          else if (responded) finish('released');
        },
      });
    } finally {
      request.signal?.removeEventListener('abort', abort);
      if (!dispatched) finish('not-started');
    }
  }

  private async runAttempt(
    request: AcpTurnRequest,
    context?: MetaTurnContext,
    physical?: {
      acquired(lease: PooledClientLease): void;
      dispatched(): void;
      released(responded: boolean): void;
    },
  ): Promise<AcpTurnResult> {
    const deadlineAt =
      request.deadlineAt ??
      (request.timeoutMs === undefined
        ? undefined
        : this.now() + request.timeoutMs);
    const controller = deadlineAt === undefined ? null : new AbortController();
    const forwardAbort = () => controller?.abort();
    request.signal?.addEventListener('abort', forwardAbort, { once: true });
    const acquireTimer =
      controller && deadlineAt !== undefined
        ? setTimeout(() => controller.abort(), Math.max(0, deadlineAt - this.now()))
        : null;
    acquireTimer?.unref?.();
    let lease: PooledClientLease;
    try {
      lease = await this.acquire(controller?.signal ?? request.signal);
    } catch (error) {
      if (deadlineAt !== undefined && this.now() >= deadlineAt) {
        throw new MetaAbortError({
          kind: 'timed_out',
          timeoutMs: request.timeoutMs,
          termination: 'not-started',
          cause: error,
        });
      }
      throw error;
    } finally {
      request.signal?.removeEventListener('abort', forwardAbort);
      if (acquireTimer) {
        clearTimeout(acquireTimer);
      }
    }
    physical?.acquired(lease);
    const client = lease.client;
    if (request.signal?.aborted) {
      this.release(lease);
      throw new MetaAbortError({
        kind: 'aborted',
        termination: 'not-started',
      });
    }
    if (deadlineAt !== undefined && this.now() >= deadlineAt) {
      this.release(lease);
      throw new MetaAbortError({
        kind: 'timed_out',
        timeoutMs: request.timeoutMs,
        termination: 'not-started',
      });
    }
    // A freshly leased client is always checked in, so its record exists (the
    // same guarantee markBusy relies on). Capture the in-flight turn so the UI
    // can show the live conversation, observing the raw streamed chunks before
    // the caller's own onActivity runs.
    const record = this.records.get(client)!;
    const live: MetaSessionLiveTurn = {
      purpose: context?.purpose ?? 'general',
      ...(context?.label ? { label: context.label } : {}),
      prompt: request.prompt,
      response: '',
      startedAt: this.now(),
    };
    record.live = live;
    const observed: AcpTurnRequest = {
      ...request,
      onActivity: (text: string): void => {
        live.response += text;
        request.onActivity?.(text);
      },
    };
    let responded = false;
    let dispatched = false;
    try {
      request.onStart?.();
      if (request.signal?.aborted) throw new MetaAbortError({ kind: 'aborted', termination: 'not-started' });
      physical?.dispatched();
      dispatched = true;
      const turn = client.runTurn({
        ...observed,
        deadlineAt,
      });
      const result = await this.awaitTurn(turn, client, request, deadlineAt);
      responded = true;
      this.servedCount += 1;
      const at = this.now();
      const inputTokens = result.usage?.inputTokens ?? 0;
      const outputTokens = result.usage?.outputTokens ?? 0;
      record.served += 1;
      record.lastActiveAt = at;
      record.inputTokens += inputTokens;
      record.outputTokens += outputTokens;
      const promptPreview = preview(request.prompt, MAX_TURN_PROMPT_CHARS);
      const responsePreview = preview(live.response, MAX_TURN_RESPONSE_CHARS);
      record.history.push({
        at,
        purpose: context?.purpose ?? 'general',
        ...(context?.label ? { label: context.label } : {}),
        ...(promptPreview ? { prompt: promptPreview } : {}),
        ...(responsePreview ? { response: responsePreview } : {}),
        inputTokens,
        outputTokens,
      });
      if (record.history.length > MAX_HISTORY) {
        record.history.splice(0, record.history.length - MAX_HISTORY);
      }
      return result;
    } finally {
      record.live = null;
      if (physical && dispatched && !responded) {
        this.deactivate(client, true);
        this.ensureTargetSize();
      }
      this.release(lease);
      physical?.released(responded);
    }
  }

  /**
   * Live-resizes the warm pool to `size` sessions without a restart. Growing
   * spawns new sessions immediately (they warm in the background); shrinking
   * retires idle surplus at once and marks any busy surplus to retire the moment
   * it finishes its current turn, so the change animates in the live view
   * instead of forcing an app restart.
   */
  resize(size: number): void {
    if (this.closed) {
      return;
    }
    this.targetSize = Math.max(0, Math.floor(size));
    this.ensureTargetSize();
    const failures: unknown[] = [];
    const retire = (client: PooledClient, disposeNow: boolean): void => {
      try { this.deactivate(client, disposeNow); } catch (error) { failures.push(error); }
    };
    for (const [client, record] of [...this.records]) {
      // Retry requested termination, but let deliberately draining busy turns finish.
      if (!record.active && !record.disposeOnRelease && client.alive) retire(client, true);
    }
    // Retire the highest-numbered idle sessions first so the survivors keep
    // their stable low ids (matching the UI's "surplus" highlight). Idle
    // clients always have a record, so the lookup is safe.
    const seqOf = (client: PooledClient): number =>
      this.records.get(client)!.seq;
    const idleBySeqDesc = [...this.idle].sort(
      (left, right) => seqOf(right) - seqOf(left),
    );
    for (const client of idleBySeqDesc) {
      if (this.activeCount() <= this.targetSize) {
        break;
      }
      retire(client, true);
    }
    for (const client of this.activeWarmingClientsBySeqDesc()) {
      if (this.activeCount() <= this.targetSize) {
        break;
      }
      retire(client, true);
    }
    for (const client of this.activeBusyClientsBySeqDesc()) {
      if (this.activeCount() <= this.targetSize) {
        break;
      }
      retire(client, false);
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Some warm metasessions could not be retired; retry resizing');
  }

  /** Attempts every termination and rejects waiters before reporting aggregated failures. */
  close(): void {
    this.closed = true;
    this.detachAdmission?.();
    this.detachAdmission = undefined;
    this.targetSize = 0;
    this.clearReplenishTimer();
    this.idle.splice(0);
    const failures: unknown[] = [];
    for (const client of [...this.records.keys()]) {
      try { this.deactivate(client, true); } catch (error) { failures.push(error); }
    }
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(new Error('MetaSessionPool is closed'));
    }
    this.notifyClosedIfNeeded();
    if (failures.length > 0) throw new MetaPoolCloseError(failures);
  }

  /**
   * Closes the pool and waits until every underlying ACP process has either
   * exited or the timeout expires.
   */
  closeAndWait(timeoutMs = this.terminationGraceMs): Promise<boolean> {
    try {
      this.close();
    } catch (error) {
      if (!(error instanceof MetaPoolCloseError)) throw error;
      // A failed kill request is not exit proof; keep waiting on the retained records.
    }
    if (this.records.size === 0) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (closed: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.closeWaiters.delete(done);
        resolve(closed);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      timer.unref?.();
      this.closeWaiters.add(done);
    });
  }

  /** Number of sessions currently idle (for tests/diagnostics). */
  get idleCount(): number {
    return this.idle.length;
  }

  /** True once at least one warm session is live and ready to serve a turn. */
  get ready(): boolean {
    return !this.closed && this.idle.length > 0;
  }

  /** Live snapshot of the pool's warm capacity for status surfaces. */
  stats(): MetaSessionPoolStats {
    const sessions = [...this.records.values()]
      .sort((left, right) => left.seq - right.seq)
      .map((record) => ({
        id: record.id,
        state: record.state,
        served: record.served,
        startedAt: record.startedAt,
        lastActiveAt: record.lastActiveAt,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        history: [...record.history],
        ...(record.live ? { live: { ...record.live } } : {}),
      }));
    return {
      size: this.targetSize,
      live: this.records.size,
      idle: this.idle.length,
      busy: [...this.records.values()].filter((record) => record.state === 'busy')
        .length,
      ready: this.ready,
      served: this.servedCount,
      sessions,
      ...(this.config.processAdmission ? {
        waitingForCapacity: this.capacityCount() < this.targetSize && !this.config.processAdmission.canAcquireWarm(),
      } : {}),
    };
  }

  private async spawn(options: {
    throwOnFailure: boolean;
    continueAfterSuccess: boolean;
  }): Promise<boolean> {
    if (this.closed || this.spawning || this.capacityCount() >= this.targetSize) {
      return false;
    }
    const processPermit = this.config.processAdmission?.tryAcquireWarm();
    if (this.config.processAdmission && !processPermit) return false;
    this.clearReplenishTimer();
    this.spawning = true;
    let client: PooledClient | null = null;
    let error: unknown;
    this.seq += 1;
    try {
      client = this.config.createClient();
      this.records.set(client, {
        processPermit: processPermit ?? undefined,
        seq: this.seq,
        id: `s${this.seq}`,
        state: 'warming',
        active: true,
        disposeOnRelease: false,
        leaseId: null,
        served: 0,
        startedAt: this.now(),
        lastActiveAt: null,
        inputTokens: 0,
        outputTokens: 0,
        history: [],
        live: null,
      });
      client.onExit(() => this.handleExit(client!));
      processPermit?.onRetire(() => this.deactivate(client!, false));
      if (!client.alive) this.handleExit(client);
      if (client.alive && this.records.get(client)?.active) await client.initialize();
    } catch (cause) {
      error = cause;
      if (client) {
        this.deactivate(client, true);
      } else {
        processPermit?.release();
      }
    } finally {
      this.spawning = false;
    }
    if (error !== undefined) {
      this.ensureTargetSize(this.replenishDelayMs);
      if (options.throwOnFailure) {
        throw error;
      }
      return true;
    }
    const warmed = client as PooledClient;
    const record = this.records.get(warmed);
    if (!record) {
      this.ensureTargetSize(this.replenishDelayMs || DEFAULT_REPLENISH_DELAY_MS);
      return false;
    }
    if (this.closed || !record.active || !warmed.alive || !warmed.reusable) {
      this.deactivate(warmed, true);
      this.ensureTargetSize(this.replenishDelayMs || DEFAULT_REPLENISH_DELAY_MS);
      return false;
    }
    this.settle(warmed, record);
    if (options.continueAfterSuccess) {
      this.ensureTargetSize();
    }
    return true;
  }

  private markBusy(client: PooledClient): PooledClientLease {
    // Only ever called for a live, checked-in client, so its record exists.
    const record = this.records.get(client)!;
    record.state = 'busy';
    record.lastActiveAt = this.now();
    record.leaseId = this.newLeaseId();
    return { client, id: record.leaseId };
  }

  private markIdle(client: PooledClient): void {
    const record = this.records.get(client)!;
    record.state = 'idle';
  }

  private checkIn(lease: PooledClientLease): void {
    const { client } = lease;
    const record = this.records.get(client);
    if (!record) {
      return;
    }
    if (record.leaseId !== lease.id) {
      return;
    }
    record.leaseId = null;
    this.settle(client, record);
  }

  private settle(client: PooledClient, record: SessionRecord): void {
    if (this.closed || !record.active || !client.alive || !client.reusable) {
      this.deactivate(client, true);
      this.ensureTargetSize();
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve(this.markBusy(client));
      return;
    }
    // A session that came free while the pool is over its (just-lowered) target
    // is retired now rather than kept warm, completing a live shrink.
    if (this.activeCount() > this.targetSize || record.disposeOnRelease) {
      this.deactivate(client, true);
      this.ensureTargetSize();
      return;
    }
    this.markIdle(client);
    if (!this.idle.includes(client)) {
      this.idle.push(client);
    }
  }

  /**
   * Removes a session from the reusable pool and disposes it. Bookkeeping stays
   * live until the process actually exits so status surfaces remain truthful.
   */
  private deactivate(client: PooledClient, disposeNow: boolean): void {
    const record = this.records.get(client);
    if (!record) {
      return;
    }
    if (!record.active) {
      // A prior kill request is not exit proof; quarantined live clients remain retryable.
      if (disposeNow && client.alive) {
        record.disposeOnRelease = false;
        record.leaseId = null;
        client.dispose();
      }
      return;
    }
    record.active = false;
    record.disposeOnRelease = !disposeNow && record.state === 'busy';
    if (!record.disposeOnRelease) {
      record.leaseId = null;
    }
    const index = this.idle.indexOf(client);
    if (index !== -1) {
      this.idle.splice(index, 1);
    }
    if (disposeNow || record.state !== 'busy') {
      record.disposeOnRelease = false;
      client.dispose();
    }
  }

  private handleExit(client: PooledClient): void {
    for (const done of this.physicalExits.get(client) ?? []) done();
    const record = this.records.get(client);
    if (!record) {
      return;
    }
    const wasActive = record.active;
    this.records.delete(client);
    record.processPermit?.release();
    const index = this.idle.indexOf(client);
    if (index !== -1) {
      this.idle.splice(index, 1);
    }
    if (wasActive && !(this.spawning && record.state === 'warming')) {
      this.ensureTargetSize();
    }
    this.notifyClosedIfNeeded();
  }

  private activeCount(): number {
    return [...this.records.values()].filter((record) => record.active).length;
  }

  private capacityCount(): number {
    return this.activeCount() + (this.spawning ? 1 : 0);
  }

  private ensureTargetSize(delayMs = 0): void {
    if (this.closed || this.spawning || this.capacityCount() >= this.targetSize) {
      return;
    }
    if (delayMs <= 0) {
      this.clearReplenishTimer();
      void this.spawn({
        throwOnFailure: false,
        continueAfterSuccess: true,
      }).catch(() => undefined);
      return;
    }
    if (this.replenishTimer) {
      return;
    }
    this.replenishTimer = setTimeout(() => {
      this.replenishTimer = null;
      this.ensureTargetSize();
    }, delayMs);
    this.replenishTimer.unref?.();
  }

  private activeBusyClientsBySeqDesc(): PooledClient[] {
    return [...this.records.entries()]
      .filter(([, record]) => record.active && record.state === 'busy')
      .sort((left, right) => right[1].seq - left[1].seq)
      .map(([client]) => client);
  }

  private activeWarmingClientsBySeqDesc(): PooledClient[] {
    return [...this.records.entries()]
      .filter(([, record]) => record.active && record.state === 'warming')
      .sort((left, right) => right[1].seq - left[1].seq)
      .map(([client]) => client);
  }

  private newLeaseId(): number {
    this.leaseSeq += 1;
    return this.leaseSeq;
  }

  private notifyClosedIfNeeded(): void {
    if (this.records.size !== 0) {
      return;
    }
    for (const waiter of this.closeWaiters) {
      waiter(true);
    }
    this.closeWaiters.clear();
  }

  private clearReplenishTimer(): void {
    if (this.replenishTimer) {
      clearTimeout(this.replenishTimer);
      this.replenishTimer = null;
    }
  }

  private awaitTurn(
    turn: Promise<AcpTurnResult>,
    client: PooledClient,
    request: AcpTurnRequest,
    deadlineAt: number | undefined,
  ): Promise<AcpTurnResult> {
    if (!request.signal && deadlineAt === undefined) {
      return turn;
    }
    return new Promise<AcpTurnResult>((resolve, reject) => {
      let settled = false;
      let stopRequested = false;
      let stopKind: 'aborted' | 'timed_out' = 'aborted';
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        request.signal?.removeEventListener('abort', onAbort);
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
        }
      };
      const finishAbort = () => {
        this.deactivate(client, true);
        this.ensureTargetSize();
        this.waitForExit(client).then((confirmed) => {
          settled = true;
          cleanup();
          reject(
            new MetaAbortError({
              kind: stopKind,
              timeoutMs: request.timeoutMs,
              termination: confirmed ? 'confirmed' : 'unconfirmed',
            }),
          );
        });
      };
      const onAbort = () => {
        stopRequested = true;
        stopKind = 'aborted';
        void finishAbort();
      };
      if (request.signal?.aborted) {
        onAbort();
      } else {
        request.signal?.addEventListener('abort', onAbort, { once: true });
      }
      if (deadlineAt !== undefined) {
        const delay = Math.max(0, deadlineAt - this.now());
        deadlineTimer = setTimeout(() => {
          if (settled || stopRequested) {
            return;
          }
          stopRequested = true;
          stopKind = 'timed_out';
          void finishAbort();
        }, delay);
        deadlineTimer.unref?.();
      }
      turn.then(
        (result) => {
          if (settled || stopRequested) {
            return;
          }
          settled = true;
          cleanup();
          resolve(result);
        },
        (error) => {
          if (settled || stopRequested) {
            return;
          }
          settled = true;
          cleanup();
          reject(error);
        },
      );
      turn.catch(() => undefined);
    });
  }

  private waitForExit(client: PooledClient): Promise<boolean> {
    if (!client.alive) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(false);
      }, this.terminationGraceMs);
      timer.unref?.();
      client.onExit(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
