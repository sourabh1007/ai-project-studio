import type { AcpTurnRequest, AcpTurnResult } from './acp-client.js';

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
  /** Terminates the process. */
  kill(): void;
  /** True until the underlying process has exited. */
  readonly alive: boolean;
}

export interface MetaSessionPoolConfig {
  /** Number of warm sessions to keep ready. */
  size: number;
  /** Creates a fresh, un-initialized client (spawns a real ACP process). */
  createClient: () => PooledClient;
  /** Clock for session timestamps; defaults to `Date.now`. */
  now?: () => number;
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
}

/** Live warm-capacity snapshot for a single pool. */
export interface MetaSessionPoolStats {
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
  resolve: (client: PooledClient) => void;
  reject: (error: Error) => void;
}

interface SessionRecord {
  /** Creation order, used for stable sorting. */
  seq: number;
  id: string;
  state: MetaSessionState;
  served: number;
  startedAt: number;
  lastActiveAt: number | null;
  inputTokens: number;
  outputTokens: number;
  history: MetaSessionTurn[];
}

/** Longest per-session usage history retained (older turns are dropped). */
const MAX_HISTORY = 25;

/** Context a caller attaches to a warm turn so its usage can be attributed. */
export interface MetaTurnContext {
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
  private liveCount = 0;
  private servedCount = 0;
  private seq = 0;
  private closed = false;
  private targetSize: number;
  private readonly now: () => number;

  constructor(private readonly config: MetaSessionPoolConfig) {
    this.now = config.now ?? (() => Date.now());
    this.targetSize = Math.max(0, Math.floor(config.size));
  }

  /** Warms the pool to its configured size. Resolves once all sessions boot. */
  async start(): Promise<void> {
    const spawns: Promise<void>[] = [];
    for (let i = 0; i < this.targetSize; i += 1) {
      spawns.push(this.spawn());
    }
    await Promise.all(spawns);
  }

  /** Leases a warm session, waiting for one to free up if all are busy. */
  acquire(): Promise<PooledClient> {
    if (this.closed) {
      return Promise.reject(new Error('MetaSessionPool is closed'));
    }
    const ready = this.idle.shift();
    if (ready) {
      this.markBusy(ready);
      return Promise.resolve(ready);
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /** Returns a leased session to the pool (or discards it if it has died). */
  release(client: PooledClient): void {
    this.checkIn(client);
  }

  /** Convenience: leases a session, runs one turn, and releases it. */
  async run(
    request: AcpTurnRequest,
    context?: MetaTurnContext,
  ): Promise<AcpTurnResult> {
    const client = await this.acquire();
    try {
      const result = await client.runTurn(request);
      this.servedCount += 1;
      const record = this.records.get(client);
      if (record) {
        const at = this.now();
        const inputTokens = result.usage?.inputTokens ?? 0;
        const outputTokens = result.usage?.outputTokens ?? 0;
        record.served += 1;
        record.lastActiveAt = at;
        record.inputTokens += inputTokens;
        record.outputTokens += outputTokens;
        record.history.push({
          at,
          purpose: context?.purpose ?? 'general',
          ...(context?.label ? { label: context.label } : {}),
          inputTokens,
          outputTokens,
        });
        if (record.history.length > MAX_HISTORY) {
          record.history.splice(0, record.history.length - MAX_HISTORY);
        }
      }
      return result;
    } finally {
      this.release(client);
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
    while (this.liveCount < this.targetSize) {
      void this.spawn().catch(() => undefined);
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
      if (this.liveCount <= this.targetSize) {
        break;
      }
      this.retire(client);
    }
  }

  /** Kills every session and rejects any pending waiters. */
  close(): void {
    this.closed = true;
    for (const client of this.idle.splice(0)) {
      this.records.delete(client);
      client.kill();
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new Error('MetaSessionPool is closed'));
    }
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
      }));
    return {
      size: this.targetSize,
      live: this.liveCount,
      idle: this.idle.length,
      busy: this.liveCount - this.idle.length,
      ready: this.ready,
      served: this.servedCount,
      sessions,
    };
  }

  private async spawn(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.liveCount += 1;
    this.seq += 1;
    const client = this.config.createClient();
    this.records.set(client, {
      seq: this.seq,
      id: `s${this.seq}`,
      state: 'warming',
      served: 0,
      startedAt: this.now(),
      lastActiveAt: null,
      inputTokens: 0,
      outputTokens: 0,
      history: [],
    });
    client.onExit(() => this.handleExit(client));
    try {
      await client.initialize();
    } catch (error) {
      this.liveCount -= 1;
      this.records.delete(client);
      throw error;
    }
    this.checkIn(client);
  }

  private markBusy(client: PooledClient): void {
    // Only ever called for a live, checked-in client, so its record exists.
    const record = this.records.get(client)!;
    record.state = 'busy';
    record.lastActiveAt = this.now();
  }

  private markIdle(client: PooledClient): void {
    const record = this.records.get(client)!;
    record.state = 'idle';
  }

  private checkIn(client: PooledClient): void {
    if (this.closed || !client.alive) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      this.markBusy(client);
      waiter.resolve(client);
      return;
    }
    // A session that came free while the pool is over its (just-lowered) target
    // is retired now rather than kept warm, completing a live shrink.
    if (this.liveCount > this.targetSize) {
      this.retire(client);
      return;
    }
    this.markIdle(client);
    this.idle.push(client);
  }

  /**
   * Removes a session from the pool and kills its process, doing the liveCount
   * / record bookkeeping up front so the later {@link handleExit} callback is a
   * no-op (its record is already gone) and never double-counts or respawns.
   */
  private retire(client: PooledClient): void {
    this.records.delete(client);
    this.liveCount -= 1;
    const index = this.idle.indexOf(client);
    if (index !== -1) {
      this.idle.splice(index, 1);
    }
    client.kill();
  }

  private handleExit(client: PooledClient): void {
    // Ignore exits for sessions already retired via resize/close, so their
    // bookkeeping (done up front) is not applied twice.
    if (!this.records.has(client)) {
      return;
    }
    this.liveCount -= 1;
    this.records.delete(client);
    const index = this.idle.indexOf(client);
    if (index !== -1) {
      this.idle.splice(index, 1);
    }
    if (!this.closed && this.liveCount < this.targetSize) {
      void this.spawn().catch(() => undefined);
    }
  }
}
