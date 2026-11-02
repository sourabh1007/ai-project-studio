import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { FileLogSinkFailure } from './log-file-sink.js';
import { createLogWriterPort, type LogWorkerLike } from './log-writer-port.js';

class FakeWorker extends EventEmitter {
  sent: unknown[] = [];
  terminated = 0;
  exitOnClose = true;
  throwOnPost = false;
  terminateImpl: () => Promise<number> = async () => { this.emit('exit', 1); return 1; };
  postMessage(m: { type: string }): void {
    if (this.throwOnPost) throw new Error('gone');
    this.sent.push(m);
    if (m.type === 'close' && this.exitOnClose) queueMicrotask(() => this.emit('exit', 0));
  }
  terminate(): Promise<number> { this.terminated += 1; return this.terminateImpl(); }
}
const make = (w: FakeWorker, onFailure?: (f: FileLogSinkFailure) => void) =>
  createLogWriterPort(w as unknown as LogWorkerLike, { closeGraceMs: 20, onFailure });

describe('log writer port', () => {
  it('posts batches and maps acks and failures', () => {
    const w = new FakeWorker();
    const onFailure = vi.fn();
    const port = make(w, onFailure);
    const ack = vi.fn();
    port.onAck(ack);
    port.post({ id: 3, entries: [{ line: 'x', at: 1 }] });
    expect(w.sent).toEqual([{ type: 'batch', id: 3, entries: [{ line: 'x', at: 1 }] }]);
    w.emit('message', { type: 'ack', id: 3, failed: true });
    w.emit('message', { type: 'failure', failure: { kind: 'failure' } });
    w.emit('message', { type: 'closed' });
    expect(ack).toHaveBeenCalledWith({ id: 3, failed: true });
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('contains throwing or missing failure observers', () => {
    const w = new FakeWorker();
    make(w, () => { throw new Error('x'); });
    expect(() => w.emit('message', { type: 'failure', failure: {} })).not.toThrow();
    const w2 = new FakeWorker();
    make(w2);
    expect(() => w2.emit('message', { type: 'failure', failure: {} })).not.toThrow();
  });

  it('reports unexpected error and exit as down, and error name only', () => {
    const w = new FakeWorker();
    const port = make(w);
    const down = vi.fn();
    port.onDown(down);
    w.emit('error', new TypeError('secret'));
    w.emit('exit', 2);
    expect(down.mock.calls).toEqual([['error:TypeError'], ['exit:2']]);
  });

  it('ignores default handlers before registration', () => {
    const w = new FakeWorker();
    make(w);
    expect(() => { w.emit('message', { type: 'ack', id: 1, failed: false }); w.emit('error', new Error('e')); }).not.toThrow();
  });

  it('close confirms a polite exit without terminating, and is idempotent', async () => {
    const w = new FakeWorker();
    const port = make(w);
    const down = vi.fn();
    port.onDown(down);
    const a = port.close();
    expect(port.close()).toBe(a);
    expect(await a).toBe(true);
    expect(w.terminated).toBe(0);
    expect(down).not.toHaveBeenCalled();
  });

  it('terminates a worker that ignores the close request', async () => {
    const w = new FakeWorker();
    w.exitOnClose = false;
    expect(await make(w).close()).toBe(true);
    expect(w.terminated).toBe(1);
  });

  it('fails closed when termination is rejected or the worker never exits', async () => {
    const w = new FakeWorker();
    w.exitOnClose = false;
    w.terminateImpl = async () => { throw new Error('no'); };
    expect(await make(w).close()).toBe(false);
    const w2 = new FakeWorker();
    w2.exitOnClose = false;
    w2.terminateImpl = async () => 0;
    expect(await make(w2).close()).toBe(false);
  });

  it('terminates when the close message cannot be posted', async () => {
    const w = new FakeWorker();
    w.throwOnPost = true;
    expect(await make(w).close()).toBe(true);
    expect(w.terminated).toBe(1);
  });

  it('resolves immediately when the worker already exited', async () => {
    const w = new FakeWorker();
    const port = make(w);
    w.emit('exit', 0);
    expect(await port.close()).toBe(true);
    expect(w.sent).toEqual([]);
  });

  it('wakes pending close waiters on exit', async () => {
    const w = new FakeWorker();
    w.exitOnClose = false;
    const port = make(w);
    const p = port.close();
    w.emit('exit', 0);
    expect(await p).toBe(true);
  });
});
