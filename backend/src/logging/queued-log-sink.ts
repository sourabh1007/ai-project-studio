import type { LogRecord, LogSink } from '../kernel/logger.js';

export interface LogBatchEntry {
  line: string;
  /** Epoch milliseconds the record was accepted, used for daily file selection. */
  at: number;
}

export interface LogBatch {
  id: number;
  entries: LogBatchEntry[];
}

/** Port to the off-thread writer. The native worker lives behind it. */
export interface LogWriterPort {
  /** Throws when the writer is gone. */
  post(batch: LogBatch): void;
  /** A failed acknowledgement means batch persistence is unconfirmed. */
  onAck(handler: (ack: { id: number; failed?: boolean }) => void): void;
  /** Fired when the writer exits or errors without being asked to close. */
  onDown(handler: (reason: string) => void): void;
  /** Resolves true only after the native worker has actually exited. */
  close(): Promise<boolean>;
}

export interface LogQueueConfig {
  queueMaxRecords: number;
  queueMaxBytes: number;
  flushIntervalMs: number;
  maxBatchRecords: number;
  writerAckTimeoutMs: number;
  maxWriterRestarts: number;
}

/** quarantined: an old writer may still be alive, so nothing is written to its file until its exit is confirmed. */
export type LogQueueState = 'running' | 'restarting' | 'quarantined' | 'failed' | 'closed';

export interface LogQueueStats {
  state: LogQueueState;
  queuedRecords: number;
  queuedBytes: number;
  inFlightRecords: number;
  /** Records the writer acknowledged as persisted. */
  written: number;
  /** Records delivered through the synchronous fallback (writer failed or queue closed). */
  fallbackWritten: number;
  dropped: {
    /** Queue was full. A marker record is written once space returns. */
    overflow: number;
    serialize: number;
    /** Writer unavailable and no fallback accepted the record. */
    unavailable: number;
  };
  /** Records refused while the old writer's exit is unconfirmed; they are neither persisted nor replayed. */
  rejected: number;
  /** Records sent to a writer that died or stalled before acknowledging, so persistence is unknown. They are never replayed. */
  unconfirmed: number;
  writerRestarts: number;
  writerFailures: number;
  lastFailure: string | null;
  /** False once any accepted record was rejected, left unconfirmed or undeliverable (overflow and serialize drops are counted separately); independent of worker exit. */
  persistenceConfirmed: boolean;
}

export type LogQueueEvent =
  | { kind: 'overflow'; dropped: number }
  | { kind: 'writer-down'; reason: string }
  | { kind: 'writer-quarantined'; reason: string }
  | { kind: 'writer-restarted'; restarts: number }
  | { kind: 'writer-failed'; reason: string };

export interface QueuedLogSinkDeps {
  config: LogQueueConfig;
  /** Formats one JSONL line; must be bounded (formatLogLine). */
  format(record: LogRecord, at: Date): string;
  spawnWriter(): LogWriterPort;
  /** Synchronous degraded path after the writer failed or the queue closed. */
  /** Must return false (or throw) when the line was not durably appended; only then is it counted as unavailable. */
  fallback?: (line: string, at: Date) => boolean | void;
  now?: () => number;
  onEvent?: (event: LogQueueEvent) => void;
}

export interface QueuedLogSink {
  sink: LogSink;
  /** True only when every accepted record was acknowledged as persisted before the deadline and none was ever left unconfirmed, rejected or undeliverable. */
  flush(timeoutMs: number): Promise<boolean>;
  /** Flushes, then stops the writer. Resolves true only after the worker physically exited, regardless of earlier write losses (see `persistenceConfirmed`). Later records use the fallback. */
  close(timeoutMs: number): Promise<boolean>;
  stats(): LogQueueStats;
}

interface Entry { line: string; at: number; bytes: number }
interface InFlight { id: number; count: number; timer: ReturnType<typeof setTimeout> }

/**
 * Bounded producer queue in front of an off-thread log writer. One batch is in
 * flight at a time (stop-and-wait), so a slow writer backs up the bounded
 * queue instead of memory. Every non-persisted record is counted: overflow is
 * marked in the log itself, and a dead or stalled writer is retired, confirmed
 * stopped, restarted a bounded number of times, then replaced by the fallback.
 */
export function createQueuedLogSink(deps: QueuedLogSinkDeps): QueuedLogSink {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  let queue: Entry[] = [];
  let queuedBytes = 0;
  let inFlight: InFlight | null = null;
  let writer: LogWriterPort | null = null;
  let state: LogQueueState = 'restarting';
  let batchSeq = 0;
  let restartsUsed = 0;
  let pendingOverflow = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let closing: Promise<boolean> | null = null;
  let sealed = false;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  const waiters = new Set<() => void>();
  const counters = {
    written: 0, fallbackWritten: 0, overflow: 0, serialize: 0, unavailable: 0,
    unconfirmed: 0, rejected: 0, writerRestarts: 0, writerFailures: 0,
  };
  let lastFailure: string | null = null;

  const emit = (event: LogQueueEvent): void => {
    try {
      deps.onEvent?.(event);
    } catch {
      // Observers must not break logging.
    }
  };
  const lossCount = (): number =>
    counters.unavailable + counters.unconfirmed + counters.rejected;
  const isIdle = (): boolean => queue.length === 0 && inFlight === null && pendingOverflow === 0;
  const notify = (): void => { for (const waiter of [...waiters]) waiter(); };
  const clearFlushTimer = (): void => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  };

  const deliverFallback = (line: string, at: number): void => {
    try {
      if (!deps.fallback) throw new Error('no fallback');
      if (deps.fallback(line, new Date(at)) === false) throw new Error('fallback write failed');
      counters.fallbackWritten += 1;
    } catch {
      counters.unavailable += 1;
    }
  };

  // A fallback writes the same file synchronously, so it is only safe once no worker can still own it.
  const divert = (line: string, at: number): void => {
    if (state === 'quarantined') counters.rejected += 1;
    else deliverFallback(line, at);
  };

  const confirmExit = (port: LogWriterPort, timeoutMs: number): Promise<boolean> => new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
    const settle = (exited: boolean): void => {
      clearTimeout(timer);
      resolve(exited);
    };
    try {
      port.close().then(settle, () => settle(false));
    } catch {
      settle(false);
    }
  });

  const formatSafely = (record: LogRecord, at: number): string | null => {
    try {
      return deps.format(record, new Date(at));
    } catch {
      return null;
    }
  };

  const takeMarker = (at: number): Entry | null => {
    if (pendingOverflow === 0) return null;
    const line = formatSafely(
      { level: 'warn', message: 'log queue overflow; records were dropped', data: { dropped: pendingOverflow } },
      at,
    );
    if (line === null) return null;
    pendingOverflow = 0;
    return { line, at, bytes: Buffer.byteLength(line) };
  };

  const push = (entry: Entry): void => {
    queue.push(entry);
    queuedBytes += entry.bytes;
  };

  const fail = (reason: string): void => {
    state = 'failed';
    lastFailure = reason;
    writer = null;
    clearFlushTimer();
    const drained = queue;
    queue = [];
    queuedBytes = 0;
    for (const entry of drained) divert(entry.line, entry.at);
    emit({ kind: 'writer-failed', reason });
    notify();
  };

  function attach(port: LogWriterPort): LogWriterPort {
    port.onAck(({ id, failed }) => {
      if (port !== writer || inFlight?.id !== id) return;
      clearTimeout(inFlight.timer);
      if (failed) counters.unconfirmed += inFlight.count;
      else counters.written += inFlight.count;
      inFlight = null;
      restartsUsed = 0;
      if (queue.length > 0) {
        if (waiters.size > 0 || queue.length >= config.maxBatchRecords) flushNow();
        else scheduleFlush();
      }
      notify();
    });
    port.onDown((reason) => {
      if (!sealed) retire(port, reason);
    });
    return port;
  }

  function startWriter(): void {
    try {
      writer = attach(deps.spawnWriter());
      state = 'running';
      if (queue.length > 0) flushNow();
    } catch {
      restartOrFail('spawn-failed');
    }
  }

  function restartOrFail(reason: string): void {
    if (sealed) return;
    if (restartsUsed >= config.maxWriterRestarts) {
      fail(reason);
      return;
    }
    restartsUsed += 1;
    counters.writerRestarts += 1;
    emit({ kind: 'writer-restarted', restarts: counters.writerRestarts });
    startWriter();
  }

  // The old worker may still be alive, so it must confirm exit before a replacement starts.
  function retire(port: LogWriterPort, reason: string): void {
    if (port !== writer) return;
    writer = null;
    state = 'restarting';
    lastFailure = reason;
    counters.writerFailures += 1;
    clearFlushTimer();
    if (inFlight) {
      clearTimeout(inFlight.timer);
      counters.unconfirmed += inFlight.count;
      inFlight = null;
    }
    emit({ kind: 'writer-down', reason });
    void confirmExit(port, config.writerAckTimeoutMs).then((exited) => {
      if (exited) restartOrFail(reason);
      else quarantine(port, reason);
    });
  }

  // Fail closed: refuse records (counted) and retry only the exit confirmation, never a second writer.
  function quarantine(port: LogWriterPort, reason: string): void {
    state = 'quarantined';
    lastFailure = `${reason}; termination unconfirmed`;
    clearFlushTimer();
    counters.rejected += queue.length;
    queue = [];
    queuedBytes = 0;
    emit({ kind: 'writer-quarantined', reason: lastFailure });
    notify();
    scheduleRelease(port, 0, reason);
  }

  function scheduleRelease(port: LogWriterPort, attempt: number, reason: string): void {
    if (sealed || attempt >= config.maxWriterRestarts) return;
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      void confirmExit(port, config.writerAckTimeoutMs).then((exited) => {
        if (sealed) return;
        if (exited) {
          state = 'restarting';
          restartOrFail(reason);
        } else scheduleRelease(port, attempt + 1, reason);
      });
    }, config.writerAckTimeoutMs);
    releaseTimer.unref();
  }

  function flushNow(): void {
    clearFlushTimer();
    if (inFlight || !writer || queue.length === 0) return;
    const port = writer;
    const taken = queue.splice(0, config.maxBatchRecords);
    for (const entry of taken) queuedBytes -= entry.bytes;
    const id = ++batchSeq;
    try {
      port.post({ id, entries: taken.map(({ line, at }) => ({ line, at })) });
    } catch {
      queue.unshift(...taken);
      for (const entry of taken) queuedBytes += entry.bytes;
      retire(port, 'post-failed');
      return;
    }
    const timer = setTimeout(() => retire(port, 'ack-timeout'), config.writerAckTimeoutMs);
    timer.unref();
    inFlight = { id, count: taken.length, timer };
  }

  function scheduleFlush(): void {
    if (flushTimer || inFlight || !writer) return;
    flushTimer = setTimeout(flushNow, config.flushIntervalMs);
    flushTimer.unref();
  }

  const sink: LogSink = (record) => {
    const at = now();
    const line = formatSafely(record, at);
    if (line === null) {
      counters.serialize += 1;
      return;
    }
    if (sealed || state === 'failed' || state === 'quarantined') {
      divert(line, at);
      return;
    }
    const bytes = Buffer.byteLength(line);
    if (queue.length >= config.queueMaxRecords || queuedBytes + bytes > config.queueMaxBytes) {
      counters.overflow += 1;
      pendingOverflow += 1;
      if (pendingOverflow === 1) emit({ kind: 'overflow', dropped: counters.overflow });
      return;
    }
    const marker = takeMarker(at);
    if (marker) push(marker);
    push({ line, at, bytes });
    if (queue.length >= config.maxBatchRecords) flushNow();
    else scheduleFlush();
  };

  const flush = (timeoutMs: number): Promise<boolean> => new Promise<boolean>((resolve) => {
    if (state === 'failed' || state === 'quarantined') {
      resolve(false);
      return;
    }
    const marker = takeMarker(now());
    if (marker) push(marker);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (): void => {
      const broken = state === 'failed' || state === 'quarantined';
      if (!broken && !isIdle()) return;
      clearTimeout(timer);
      waiters.delete(check);
      resolve(!broken && lossCount() === 0);
    };
    timer = setTimeout(() => {
      waiters.delete(check);
      resolve(false);
    }, timeoutMs);
    waiters.add(check);
    flushNow();
    check();
  });

  const close = (timeoutMs: number): Promise<boolean> => {
    closing ??= (async () => {
      const startedAt = now();
      await flush(timeoutMs);
      sealed = true;
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = null;
      let exited = state !== 'quarantined';
      if (state === 'running' || state === 'restarting') state = 'closed';
      const port = writer;
      writer = null;
      clearFlushTimer();
      if (port) {
        exited = await confirmExit(port, Math.max(0, timeoutMs - (now() - startedAt)));
        if (!exited) {
          state = 'quarantined';
          lastFailure = 'close; termination unconfirmed';
          emit({ kind: 'writer-quarantined', reason: lastFailure });
        }
      }
      if (inFlight) {
        clearTimeout(inFlight.timer);
        counters.unconfirmed += inFlight.count;
        inFlight = null;
      }
      const left = queue;
      queue = [];
      queuedBytes = 0;
      for (const entry of left) divert(entry.line, entry.at);
      notify();
      return exited;
    })();
    return closing;
  };

  const stats = (): LogQueueStats => ({
    state,
    queuedRecords: queue.length,
    queuedBytes,
    inFlightRecords: inFlight?.count ?? 0,
    written: counters.written,
    fallbackWritten: counters.fallbackWritten,
    dropped: { overflow: counters.overflow, serialize: counters.serialize, unavailable: counters.unavailable },
    unconfirmed: counters.unconfirmed,
    rejected: counters.rejected,
    writerRestarts: counters.writerRestarts,
    writerFailures: counters.writerFailures,
    lastFailure,
    persistenceConfirmed: lossCount() === 0,
  });

  startWriter();
  return { sink, flush, close, stats };
}
