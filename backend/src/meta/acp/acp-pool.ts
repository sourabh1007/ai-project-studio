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
  private readonly now: () => number;

  constructor(private readonly config: MetaSessionPoolConfig) {
    this.now = config.now ?? (() => Date.now());
  }

  /** Warms the pool to its configured size. Resolves once all sessions boot. */
  async start(): Promise<void> {
    const spawns: Promise<void>[] = [];
    for (let i = 0; i < this.config.size; i += 1) {
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
  async run(request: AcpTurnRequest): Promise<AcpTurnResult> {
    const client = await this.acquire();
    try {
      const result = await client.runTurn(request);
      this.servedCount += 1;
      const record = this.records.get(client);
      if (record) {
        record.served += 1;
        record.lastActiveAt = this.now();
      }
      return result;
    } finally {
      this.release(client);
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
      }));
    return {
      size: this.config.size,
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
    this.markIdle(client);
    this.idle.push(client);
  }

  private handleExit(client: PooledClient): void {
    this.liveCount -= 1;
    this.records.delete(client);
    const index = this.idle.indexOf(client);
    if (index !== -1) {
      this.idle.splice(index, 1);
    }
    if (!this.closed && this.liveCount < this.config.size) {
      void this.spawn().catch(() => undefined);
    }
  }
}
