import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogRecord } from '../kernel/logger.js';
import {
  createQueuedLogSink,
  type LogBatch,
  type LogQueueConfig,
  type LogQueueEvent,
  type LogWriterPort,
  type QueuedLogSinkDeps,
} from './queued-log-sink.js';

const baseConfig: LogQueueConfig = {
  queueMaxRecords: 10,
  queueMaxBytes: 10_000,
  flushIntervalMs: 50,
  maxBatchRecords: 3,
  writerAckTimeoutMs: 1000,
  maxWriterRestarts: 2,
};

class FakePort implements LogWriterPort {
  posted: LogBatch[] = [];
  failPost = false;
  closeResult: boolean | 'reject' | 'hang' = true;
  closeCalls = 0;
  ackHandler: (ack: { id: number; failed?: boolean }) => void = () => {};
  private downHandler: (reason: string) => void = () => {};
  post(batch: LogBatch): void {
    if (this.failPost) throw new Error('worker gone');
    this.posted.push(batch);
  }
  onAck(handler: (ack: { id: number; failed?: boolean }) => void): void { this.ackHandler = handler; }
  onDown(handler: (reason: string) => void): void { this.downHandler = handler; }
  close(): Promise<boolean> {
    this.closeCalls += 1;
    if (this.closeResult === 'reject') return Promise.reject(new Error('close failed'));
    if (this.closeResult === 'hang') return new Promise(() => {});
    return Promise.resolve(this.closeResult);
  }
  ack(id = this.posted.at(-1)!.id): void { this.ackHandler({ id }); }
  down(reason = 'exit'): void { this.downHandler(reason); }
  lines(): string[] { return this.posted.flatMap((batch) => batch.entries.map((entry) => entry.line)); }
}

const rec = (message: string): LogRecord => ({ level: 'info', message });
const format = (record: LogRecord, at: Date): string => `${at.getTime()}|${record.message}|${JSON.stringify(record.data ?? null)}\n`;

function setup(overrides: Partial<Omit<QueuedLogSinkDeps, 'config'>> & { config?: Partial<LogQueueConfig> } = {}) {
  const ports: FakePort[] = [];
  const events: LogQueueEvent[] = [];
  const fallback = vi.fn();
  const { config, ...rest } = overrides;
  const queued = createQueuedLogSink({
    config: { ...baseConfig, ...config },
    format,
    spawnWriter: () => { const port = new FakePort(); ports.push(port); return port; },
    fallback,
    onEvent: (event) => events.push(event),
    ...rest,
  });
  return { queued, ports, events, fallback };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => { vi.useRealTimers(); });

describe('queued log sink normal operation', () => {
  it('persists every record exactly once, in order, in stop-and-wait batches', async () => {
    const { queued, ports } = setup();
    for (let i = 0; i < 7; i += 1) queued.sink(rec(`m${i}`));
    // Three records fill a batch and flush immediately; the writer then owns one in-flight batch.
    expect(ports[0].posted.map((b) => b.entries.length)).toEqual([3]);
    queued.sink(rec('m7'));
    await vi.advanceTimersByTimeAsync(100);
    expect(ports[0].posted).toHaveLength(1);
    expect(queued.stats()).toMatchObject({ queuedRecords: 5, inFlightRecords: 3, written: 0, state: 'running' });
    ports[0].ack();
    expect(ports[0].posted).toHaveLength(2);
    ports[0].ack();
    await vi.advanceTimersByTimeAsync(60);
    expect(ports[0].posted).toHaveLength(3);
    ports[0].ack();
    expect(ports[0].lines().map((line) => line.split('|')[1])).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    expect(queued.stats()).toMatchObject({ written: 8, queuedRecords: 0, queuedBytes: 0, inFlightRecords: 0 });
  });

  it('flushes a small backlog on the interval and coalesces the timer', async () => {
    const { queued, ports } = setup();
    queued.sink(rec('a'));
    queued.sink(rec('b'));
    expect(ports[0].posted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(ports[0].posted[0].entries.map((entry) => entry.at)).toEqual([1000, 1000]);
    queued.sink(rec('c'));
    await vi.advanceTimersByTimeAsync(100);
    expect(ports[0].posted).toHaveLength(1);
    ports[0].ack();
    await vi.advanceTimersByTimeAsync(50);
    expect(ports[0].posted).toHaveLength(2);
  });

  it('ignores stale or unknown acknowledgements', async () => {
    const { queued, ports } = setup();
    queued.sink(rec('a'));
    await vi.advanceTimersByTimeAsync(50);
    ports[0].ack(999);
    expect(queued.stats().written).toBe(0);
    ports[0].ack();
    ports[0].ack();
    expect(queued.stats().written).toBe(1);
  });

  it('counts serialization failures instead of dropping silently', () => {
    const { queued } = setup({ format: () => { throw new Error('bad'); } });
    queued.sink(rec('a'));
    expect(queued.stats().dropped.serialize).toBe(1);
  });
});

describe('queued log sink overflow', () => {
  it('bounds records, reports once per burst and marks the gap in the log itself', async () => {
    const { queued, ports, events } = setup({ config: { queueMaxRecords: 2, maxBatchRecords: 5 } });
    for (const name of ['a', 'b', 'c', 'd']) queued.sink(rec(name));
    expect(queued.stats()).toMatchObject({ queuedRecords: 2, dropped: { overflow: 2 } });
    expect(events).toEqual([{ kind: 'overflow', dropped: 1 }]);
    await vi.advanceTimersByTimeAsync(50);
    ports[0].ack();
    queued.sink(rec('e'));
    await vi.advanceTimersByTimeAsync(50);
    const lines = ports[0].lines().map((line) => line.trim().split('|').slice(1, 3).join('|'));
    expect(lines).toEqual(['a|null', 'b|null', 'log queue overflow; records were dropped|{"dropped":2}', 'e|null']);
  });

  it('bounds bytes and writes the marker on flush when no later record arrives', async () => {
    const { queued, ports } = setup({ config: { queueMaxBytes: 40 } });
    queued.sink(rec('a'));
    queued.sink(rec('b'.repeat(100)));
    expect(queued.stats()).toMatchObject({ queuedRecords: 1, dropped: { overflow: 1 } });
    const flushed = queued.flush(1000);
    expect(ports[0].lines().at(-1)).toContain('log queue overflow');
    ports[0].ack();
    ports[0].ack();
    expect(await flushed).toBe(true);
  });

  it('keeps counting when the marker itself cannot be formatted', () => {
    let failMarker = false;
    const { queued, ports } = setup({
      config: { queueMaxRecords: 1 },
      format: (record, at) => {
        if (failMarker && record.message.includes('overflow')) throw new Error('marker');
        return format(record, at);
      },
    });
    queued.sink(rec('a'));
    queued.sink(rec('b'));
    failMarker = true;
    void queued.flush(100);
    ports[0].ack();
    queued.sink(rec('c'));
    expect(queued.stats()).toMatchObject({ queuedRecords: 1, dropped: { overflow: 1 } });
  });

  it('contains throwing event observers', () => {
    const { queued } = setup({ config: { queueMaxRecords: 1 }, onEvent: () => { throw new Error('observer'); } });
    queued.sink(rec('a'));
    expect(() => queued.sink(rec('b'))).not.toThrow();
  });
});

describe('queued log sink writer failures', () => {
  it('retires a stalled writer, waits for confirmed exit, restarts and resumes without duplicates', async () => {
    const { queued, ports, events } = setup();
    queued.sink(rec('a'));
    queued.sink(rec('b'));
    await vi.advanceTimersByTimeAsync(50);
    queued.sink(rec('c'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(ports[0].closeCalls).toBe(1);
    expect(ports).toHaveLength(2);
    expect(queued.stats()).toMatchObject({ unconfirmed: 2, writerFailures: 1, writerRestarts: 1, state: 'running' });
    expect(events.map((event) => event.kind)).toEqual(['writer-down', 'writer-restarted']);
    await vi.advanceTimersByTimeAsync(50);
    expect(ports[1].lines().map((line) => line.split('|')[1])).toEqual(['c']);
    ports[1].ack();
    expect(queued.stats()).toMatchObject({ written: 1, writerFailures: 1 });
  });

  it('does not start a replacement until termination is confirmed; unconfirmed exit fails closed', async () => {
    const { queued, ports, fallback } = setup();
    ports[0].closeResult = 'hang';
    queued.sink(rec('a'));
    await vi.advanceTimersByTimeAsync(50);
    ports[0].down('error');
    queued.sink(rec('b'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(ports).toHaveLength(1);
    expect(queued.stats()).toMatchObject({ state: 'quarantined', queuedRecords: 0, unconfirmed: 1, rejected: 1 });
    ports[0].down('exit');
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([[false, 'termination unconfirmed'], ['reject', 'termination unconfirmed']] as const)(
    'quarantines instead of using the fallback when old worker close result is %s',
    async (result, text) => {
      const { queued, ports, fallback, events } = setup({ config: { maxWriterRestarts: 0 } });
      ports[0].closeResult = result;
      queued.sink(rec('a'));
      queued.sink(rec('b'));
      ports[0].down('exit');
      await vi.advanceTimersByTimeAsync(0);
      expect(ports).toHaveLength(1);
      expect(queued.stats()).toMatchObject({ state: 'quarantined', queuedRecords: 0, rejected: 2, fallbackWritten: 0 });
      expect(queued.stats().lastFailure).toContain(text);
      queued.sink(rec('c'));
      expect(queued.stats().rejected).toBe(3);
      expect(fallback).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({ kind: 'writer-quarantined' });
      expect(await queued.flush(10)).toBe(false);
    },
  );

  it('degrades to the fallback once the restart budget is exhausted and resets it after a good ack', async () => {
    const { queued, ports } = setup({ config: { maxWriterRestarts: 1 } });
    queued.sink(rec('a'));
    await vi.advanceTimersByTimeAsync(50);
    ports[0].down();
    await vi.advanceTimersByTimeAsync(0);
    expect(ports).toHaveLength(2);
    queued.sink(rec('b'));
    await vi.advanceTimersByTimeAsync(50);
    ports[1].ack();
    ports[1].down();
    await vi.advanceTimersByTimeAsync(0);
    expect(ports).toHaveLength(3);
    ports[2].down();
    await vi.advanceTimersByTimeAsync(0);
    expect(queued.stats().state).toBe('failed');
    expect(ports).toHaveLength(3);
  });

  it('retries a failing spawn within budget, then fails explicitly', () => {
    const spawn = vi.fn(() => { throw new Error('no worker'); });
    const events: LogQueueEvent[] = [];
    const fallback = vi.fn();
    const queued = createQueuedLogSink({
      config: baseConfig, format, spawnWriter: spawn, fallback, onEvent: (event) => events.push(event),
    });
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(queued.stats()).toMatchObject({ state: 'failed', writerRestarts: 2, lastFailure: 'spawn-failed' });
    queued.sink(rec('x'));
    expect(fallback).toHaveBeenCalledOnce();
    const none = createQueuedLogSink({
      config: { ...baseConfig, maxWriterRestarts: 0 }, format, spawnWriter: spawn,
    });
    none.sink(rec('x'));
    expect(none.stats()).toMatchObject({ state: 'failed', dropped: { unavailable: 1 } });
  });

  it('requeues a rejected post at the front and retires the writer', async () => {
    const { queued, ports } = setup();
    ports[0].failPost = true;
    queued.sink(rec('a'));
    queued.sink(rec('b'));
    await vi.advanceTimersByTimeAsync(50);
    expect(queued.stats()).toMatchObject({ writerFailures: 1, writerRestarts: 1 });
    expect(ports).toHaveLength(2);
    expect(ports[1].lines().map((line) => line.split('|')[1])).toEqual(['a', 'b']);
  });

  it('ignores events from a replaced writer and counts fallback delivery failures', async () => {
    const { queued, ports } = setup({ fallback: () => { throw new Error('stderr gone'); }, config: { maxWriterRestarts: 0 } });
    ports[0].down();
    ports[0].down();
    await vi.advanceTimersByTimeAsync(0);
    queued.sink(rec('a'));
    expect(queued.stats()).toMatchObject({ state: 'failed', writerFailures: 1, dropped: { unavailable: 1 } });
  });
});

describe('queued log sink flush and close', () => {
  it('flush resolves immediately when idle and times out when the writer never acknowledges', async () => {
    const { queued } = setup();
    expect(await queued.flush(10)).toBe(true);
    queued.sink(rec('a'));
    const flushed = queued.flush(200);
    await vi.advanceTimersByTimeAsync(200);
    expect(await flushed).toBe(false);
  });

  it('flush keeps draining multiple batches without waiting for the interval', async () => {
    const { queued, ports } = setup({ config: { maxBatchRecords: 2, queueMaxRecords: 10 } });
    for (const name of ['a', 'b', 'c']) queued.sink(rec(name));
    const flushed = queued.flush(1000);
    ports[0].ack();
    expect(ports[0].posted).toHaveLength(2);
    ports[0].ack();
    expect(await flushed).toBe(true);
    expect(queued.stats().written).toBe(3);
  });

  it('close persists, confirms worker exit, and routes later records to the fallback', async () => {
    const { queued, ports, fallback } = setup();
    queued.sink(rec('a'));
    const closed = queued.close(1000);
    ports[0].ack();
    expect(await closed).toBe(true);
    expect(await queued.close(1000)).toBe(true);
    expect(ports[0].closeCalls).toBe(1);
    expect(queued.stats().state).toBe('closed');
    queued.sink(rec('late'));
    expect(fallback).toHaveBeenCalledOnce();
    expect(queued.stats().fallbackWritten).toBe(1);
  });

  it.each([['hang'], ['reject'], [false]] as const)('close reports false when worker exit is %s', async (result) => {
    const { queued, ports } = setup();
    ports[0].closeResult = result;
    const closed = queued.close(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await closed).toBe(false);
  });

  it('close reports the physical exit while stats flag the unconfirmed batch, and ignores later down events', async () => {
    const { queued, ports } = setup();
    queued.sink(rec('a'));
    const closed = queued.close(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await closed).toBe(true);
    expect(queued.stats()).toMatchObject({ unconfirmed: 1, state: 'closed', persistenceConfirmed: false });
    ports[0].down();
    await vi.advanceTimersByTimeAsync(2000);
    expect(ports).toHaveLength(1);
  });

  it('close after a failed writer needs no worker and a retiring writer cannot restart during close', async () => {
    const failed = setup({ config: { maxWriterRestarts: 0 } });
    failed.ports[0].down();
    await vi.advanceTimersByTimeAsync(0);
    expect(await failed.queued.close(50)).toBe(true);
    expect(failed.queued.stats().state).toBe('failed');

    const { queued, ports } = setup();
    let finish!: (value: boolean) => void;
    ports[0].close = () => new Promise<boolean>((resolve) => { finish = resolve; });
    ports[0].down();
    const closed = queued.close(50);
    finish(true);
    await vi.advanceTimersByTimeAsync(50);
    await closed;
    expect(ports).toHaveLength(1);
  });
});

describe('queued log sink write failures reported by the writer', () => {
  it('never counts a batch with writer-reported failures as written', async () => {
    const { queued, ports } = setup();
    queued.sink(rec('a'));
    await vi.advanceTimersByTimeAsync(50);
    ports[0].ackHandler({ id: 1, failed: true });
    expect(queued.stats()).toMatchObject({ written: 0, unconfirmed: 1, state: 'running', persistenceConfirmed: false });
    expect(await queued.flush(10)).toBe(false);
    queued.sink(rec('b'));
    await vi.advanceTimersByTimeAsync(50);
    ports[0].ackHandler({ id: 2 });
    expect(queued.stats()).toMatchObject({ written: 1, unconfirmed: 1 });
    expect(await queued.flush(10)).toBe(false);
  });
});

describe('queued log sink old-writer ownership', () => {
  const stall = async (ports: FakePort[], queued: ReturnType<typeof setup>['queued']) => {
    ports[0].closeResult = 'hang';
    queued.sink(rec('a'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
  };

  it('never replaces or falls back while the old worker may be alive, then restarts only after confirmed exit', async () => {
    const { queued, ports, fallback, events } = setup();
    await stall(ports, queued);
    expect(queued.stats()).toMatchObject({ state: 'quarantined', unconfirmed: 1, writerFailures: 1 });
    queued.sink(rec('b'));
    queued.sink(rec('c'));
    expect(queued.stats().rejected).toBe(2);
    expect(ports).toHaveLength(1);
    expect(fallback).not.toHaveBeenCalled();
    ports[0].closeResult = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(ports).toHaveLength(2);
    expect(queued.stats().state).toBe('running');
    queued.sink(rec('d'));
    await vi.advanceTimersByTimeAsync(50);
    ports[1].ack();
    const persisted = ports.flatMap((port) => port.lines()).map((line) => line.split('|')[1]);
    expect(persisted).toEqual(['a', 'd']);
    expect(new Set(persisted).size).toBe(persisted.length);
    expect(queued.stats()).toMatchObject({ written: 1, unconfirmed: 1, rejected: 2, fallbackWritten: 0 });
    expect(events.map((event) => event.kind)).toContain('writer-quarantined');
  });

  it('uses the fallback only once the old worker exit is confirmed and the restart budget is spent', async () => {
    const { queued, ports, fallback } = setup({ config: { maxWriterRestarts: 0 } });
    queued.sink(rec('a'));
    queued.sink(rec('b'));
    ports[0].down();
    await vi.advanceTimersByTimeAsync(0);
    expect(ports[0].closeCalls).toBe(1);
    expect(queued.stats()).toMatchObject({ state: 'failed', fallbackWritten: 2, rejected: 0 });
    expect(fallback.mock.calls.map((call) => String(call[0]).split('|')[1])).toEqual(['a', 'b']);
  });

  it('keeps the quarantine after the bounded retries are exhausted', async () => {
    const { queued, ports, fallback } = setup({ config: { maxWriterRestarts: 1 } });
    await stall(ports, queued);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ports[0].closeCalls).toBe(2);
    expect(ports).toHaveLength(1);
    queued.sink(rec('x'));
    expect(queued.stats()).toMatchObject({ state: 'quarantined', rejected: 1 });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('cannot be completed by a stale acknowledgement from the replaced writer', async () => {
    const { queued, ports } = setup();
    queued.sink(rec('a'));
    await vi.advanceTimersByTimeAsync(50);
    const staleId = ports[0].posted[0].id;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ports).toHaveLength(2);
    queued.sink(rec('b'));
    await vi.advanceTimersByTimeAsync(50);
    const liveId = ports[1].posted[0].id;
    expect(liveId).not.toBe(staleId);
    ports[0].ackHandler({ id: liveId });
    ports[0].ackHandler({ id: staleId });
    expect(queued.stats()).toMatchObject({ written: 0, inFlightRecords: 1 });
    ports[1].ack();
    expect(queued.stats()).toMatchObject({ written: 1, unconfirmed: 1 });
  });

  it('treats a close that throws synchronously as unconfirmed', async () => {
    const { queued, ports } = setup({ config: { maxWriterRestarts: 0 } });
    ports[0].close = () => { throw new Error('boom'); };
    ports[0].down();
    await vi.advanceTimersByTimeAsync(0);
    expect(queued.stats().state).toBe('quarantined');
  });

  it('closing while a release retry is pending cancels it', async () => {
    const { queued, ports } = setup();
    await stall(ports, queued);
    expect(await queued.close(50)).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ports[0].closeCalls).toBe(1);
  });

  it('closing during quarantine stops retries, stays unconfirmed and refuses later records', async () => {
    const { queued, ports, fallback, events } = setup();
    await stall(ports, queued);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await queued.close(50)).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ports).toHaveLength(1);
    queued.sink(rec('late'));
    expect(queued.stats()).toMatchObject({ state: 'quarantined', rejected: 1, fallbackWritten: 0 });
    expect(fallback).not.toHaveBeenCalled();
    expect(events.filter((event) => event.kind === 'writer-quarantined')).toHaveLength(1);
  });

  it('a close whose worker exit is unconfirmed rejects leftovers; a confirmed one delivers them via the fallback', async () => {
    const stuck = setup();
    stuck.queued.sink(rec('a'));
    await vi.advanceTimersByTimeAsync(50);
    stuck.queued.sink(rec('b'));
    stuck.ports[0].closeResult = 'hang';
    const stuckClose = stuck.queued.close(100);
    await vi.advanceTimersByTimeAsync(200);
    expect(await stuckClose).toBe(false);
    expect(stuck.queued.stats()).toMatchObject({ state: 'quarantined', rejected: 1, unconfirmed: 1, fallbackWritten: 0 });
    expect(stuck.fallback).not.toHaveBeenCalled();
    expect(stuck.events.at(-1)).toMatchObject({ kind: 'writer-quarantined' });

    const clean = setup();
    clean.queued.sink(rec('a'));
    await vi.advanceTimersByTimeAsync(50);
    clean.queued.sink(rec('b'));
    const cleanClose = clean.queued.close(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await cleanClose).toBe(true);
    expect(clean.queued.stats()).toMatchObject({ state: 'closed', fallbackWritten: 1, unconfirmed: 1, queuedRecords: 0, persistenceConfirmed: false });
  });
});

describe('queued log sink checked fallback', () => {
  it('counts a fallback that reports false as unavailable, not as written', async () => {
    const { queued, ports } = setup({ fallback: () => false, config: { maxWriterRestarts: 0 } });
    queued.sink(rec('a'));
    ports[0].down();
    await vi.advanceTimersByTimeAsync(0);
    queued.sink(rec('b'));
    expect(queued.stats()).toMatchObject({ fallbackWritten: 0, dropped: { unavailable: 2 } });
  });

});
