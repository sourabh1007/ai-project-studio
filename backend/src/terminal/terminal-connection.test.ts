import { describe, it, expect, vi } from 'vitest';
import { createTerminalConnection } from './terminal-connection.js';
import { createTerminalSession, type TerminalSession } from './terminal-session.js';
import type { ServerMessage } from './terminal-protocol.js';

function fixture(ready = false, limit = 16, generation = 1) {
  let listener!: (terminal: TerminalSession | null, failed?: boolean) => void;
  let resolve!: (terminal: TerminalSession) => void;
  let reject!: (error: Error) => void;
  let output!: (data: string) => void;
  let exit!: (code: number | null) => void;
  const writes: string[] = [];
  const resizes: number[][] = [];
  const frames: ServerMessage[] = [];
  const observed: string[] = [];
  const terminal = createTerminalSession({
    sessionId: 's1', generation, inputReady: ready, scrollbackBytes: 100, transcriptBytes: 100,
    pty: {
      write: (data) => { writes.push(data); },
      resize: (cols, rows) => { resizes.push([cols, rows]); },
      onData: (fn) => { output = fn; }, onExit: (fn) => { exit = fn; }, kill: () => {},
    },
    onExit: () => {},
  });
  const unsub = vi.fn();
  const connection = createTerminalConnection({
    launch: () => new Promise((yes, no) => { resolve = yes; reject = no; }),
    subscribe: (fn) => { listener = fn; return unsub; },
    observeInput: (data) => observed.push(data), send: (frame) => frames.push(frame), inputLimit: limit,
  });
  const started = connection.start();
  let seq = 0;
  const input = (data: string, generation = 1) => connection.receive({ type: 'input', data, generation, seq: ++seq });
  return {
    connection, terminal, frames, writes, resizes, observed, unsub, input, started,
    bind: (next: TerminalSession | null, failed?: boolean) => listener(next, failed),
    launch: () => resolve(terminal), reject: () => reject(new Error('launch failed')),
    output: (data: string) => output(data), exit: () => exit(0),
  };
}

describe('terminal connection ownership', () => {
  it('queues before launch, applies latest geometry then flushes through write AND observation', async () => {
    const f = fixture();
    f.input('FIRST', 0); f.input('SECOND', 0);
    f.connection.receive({ type: 'resize', cols: 80, rows: 24, generation: 0 });
    f.connection.receive({ type: 'resize', cols: 100, rows: 30, generation: 0 });
    f.bind(f.terminal); f.launch(); await f.started;
    expect(f.writes).toEqual([]);
    f.terminal.markInputReady();
    expect(f.writes).toEqual(['FIRST', 'SECOND']);
    expect(f.observed).toEqual(f.writes);
    expect(f.resizes).toEqual([[100, 30]]);
    f.input('NEXT');
    f.connection.receive({ type: 'resize', cols: 110, rows: 40, generation: 1 });
    f.output('hello');
    expect(f.frames).toContainEqual({ type: 'output', data: 'hello' });
    expect(f.writes).toEqual(['FIRST', 'SECOND', 'NEXT']);
    f.connection.close();
    const count = f.frames.length;
    f.output('detached'); f.exit();
    expect(f.frames).toHaveLength(count);
  });
  it('detaches before delayed launch resolves, ignores subsequent input and notifications', async () => {
    const f = fixture();
    f.input('X', 0);
    f.connection.close();
    const attach = vi.spyOn(f.terminal, 'attach');
    f.launch(); await f.started;
    f.bind(f.terminal); f.input('Y');
    f.terminal.markInputReady();
    expect(attach).not.toHaveBeenCalled();
    expect(f.unsub).toHaveBeenCalledOnce();
    expect(f.writes).toEqual([]);
  });
  it('surfaces launch failure only while connected', async () => {
    const f = fixture(); f.input('X', 0); f.reject(); await f.started;
    expect(f.frames).toContainEqual(expect.objectContaining({ type: 'state', state: 'failed' }));
    const closed = fixture(); closed.connection.close(); closed.reject(); await closed.started;
    expect(closed.frames).toHaveLength(1);
  });
  it('makes ready → closed observable and rejects closed, failed, stale, duplicate and reconnecting input', async () => {
    const f = fixture(true); f.launch(); await f.started;
    f.input('X');
    f.connection.receive({ type: 'input', data: 'X', seq: 1, generation: 1 });
    f.input('stale', 0);
    f.connection.receive({ type: 'resize', cols: 1, rows: 1, generation: 0 });
    f.bind(null);
    f.input('no'); f.connection.receive({ type: 'resize', cols: 1, rows: 1, generation: 1 });
    f.bind(f.terminal); // Delayed old launch completion must not reattach.
    const next = fixture(true, 16, 2);
    f.bind(next.terminal);
    next.exit();
    f.input('closed', 2); f.connection.receive({ type: 'resize', cols: 1, rows: 1, generation: 2 });
    next.launch(); await next.started;
    expect(f.writes).toEqual(['X']);
    expect(f.frames).toContainEqual(expect.objectContaining({ type: 'state', state: 'closed' }));
  });
  it('rejects old queued input on replacement and queued input on exit', async () => {
    const f = fixture(); f.launch(); await f.started;
    f.input('old'); f.bind(null);
    const replacement = fixture(false, 16, 2);
    f.bind(replacement.terminal);
    f.input('new', 2); replacement.exit();
    expect(f.frames.filter((m) => m.type === 'ack').map((m) => m.outcome)).toEqual(['rejected', 'rejected']);
    replacement.launch(); await replacement.started;
  });
  it('overlimit UTF-8 paste rejects all pending input and later Enter with a visible final failure', async () => {
    const f = fixture(false, 4);
    f.input('a', 0); f.input('😀', 0); f.input('\r', 0);
    f.connection.receive({ type: 'resize', cols: 1, rows: 1, generation: 0 });
    f.launch(); await f.started; f.terminal.markInputReady();
    expect(f.writes).toEqual([]);
    expect(f.frames.filter((m) => m.type === 'ack').map((m) => m.outcome)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(f.frames.filter((m) => m.type === 'state').at(-1)).toEqual(expect.objectContaining({ type: 'state', state: 'failed' }));
    f.bind(null);
    expect(f.frames.at(-1)).toEqual(expect.objectContaining({ state: 'failed' }));
  });
  it('reports failed recovery without reattaching the old terminal', async () => {
    const f = fixture(true); f.launch(); await f.started;
    f.bind(null); f.bind(null, true); f.bind(f.terminal);
    expect(f.frames.at(-1)).toEqual(expect.objectContaining({ state: 'failed' }));
  });
  it('observes user intent before uncertain writes and rejects the queued tail', async () => {
    const f = fixture();
    f.input('A', 0); f.input('B', 0);
    vi.spyOn(f.terminal, 'write').mockImplementation(() => { throw new Error('partial write'); });
    f.launch(); await f.started;
    f.terminal.markInputReady();
    expect(f.observed).toEqual(['A', 'B']);
    expect(f.frames.filter((m) => m.type === 'ack').map((m) => m.outcome)).toEqual(['uncertain', 'rejected']);
    f.input('\r');
    expect(f.writes).toEqual([]);
    const last = fixture();
    last.input('A', 0);
    vi.spyOn(last.terminal, 'write').mockImplementation(() => { throw new Error('write'); });
    last.launch(); await last.started; last.terminal.markInputReady();
  });
  it('observes current-generation cancellation during reconnect without writing or observing stale input', async () => {
    const f = fixture(true);
    f.launch(); await f.started;
    f.bind(null);
    f.input('\x03');
    f.input('stale', 0);
    expect(f.observed).toEqual(['\x03']);
    expect(f.writes).toEqual([]);
    expect(f.frames.filter((m) => m.type === 'ack').map((m) => m.outcome)).toEqual(['rejected', 'rejected']);
  });
  it('resize failure stops queued writes, both on readiness and live resize', async () => {
    for (const ready of [true, false]) {
      const f = fixture(ready);
      vi.spyOn(f.terminal, 'resize').mockImplementation(() => { throw new Error('resize'); });
      if (ready) { f.launch(); await f.started; }
      f.connection.receive({ type: 'resize', cols: 80, rows: 24, generation: ready ? 1 : 0 });
      if (!ready) { f.launch(); await f.started; f.terminal.markInputReady(); }
      expect(f.frames.at(-1)).toEqual(expect.objectContaining({ type: 'state', state: 'failed' }));
    }
  });
});
