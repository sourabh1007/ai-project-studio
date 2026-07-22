import { describe, it, expect } from 'vitest';
import { createTerminalSession } from './terminal-session.js';
import type { PtyProcess } from './pty-contract.js';

function fakePty() {
  let dataCb: (d: string) => void = () => {};
  let exitCb: (c: number | null) => void = () => {};
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  let killed = false;
  const pty: PtyProcess = {
    write: (d) => writes.push(d),
    resize: (c, r) => resizes.push([c, r]),
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    kill: () => {
      killed = true;
    },
  };
  return {
    pty,
    emitData: (d: string) => dataCb(d),
    emitExit: (c: number | null) => exitCb(c),
    writes,
    resizes,
    wasKilled: () => killed,
  };
}

function recordingSink() {
  const output: string[] = [];
  const exits: Array<number | null> = [];
  return {
    sink: { send: (d: string) => output.push(d), exit: (c: number | null) => exits.push(c) },
    output,
    exits,
  };
}

describe('createTerminalSession', () => {
  it('fans live output to attached sinks and accumulates a stripped transcript', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 's1',
      pty: f.pty,
      scrollbackBytes: 1000,
      onExit: () => {},
    });
    const a = recordingSink();
    session.attach(a.sink);
    f.emitData('\u001b[31mhello\u001b[0m');
    expect(a.output).toEqual(['\u001b[31mhello\u001b[0m']);
    expect(session.transcriptText()).toBe('hello');
    expect(session.exited).toBe(false);
    expect(session.exitCode).toBeNull();
  });

  it('replays scrollback on attach and detach stops further sends', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 's1',
      pty: f.pty,
      scrollbackBytes: 1000,
      onExit: () => {},
    });
    f.emitData('past output');
    const a = recordingSink();
    const detach = session.attach(a.sink);
    expect(a.output).toEqual(['past output']);
    detach();
    f.emitData('more');
    expect(a.output).toEqual(['past output']);
  });

  it('bounds retained scrollback to scrollbackBytes', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 's1',
      pty: f.pty,
      scrollbackBytes: 4,
      onExit: () => {},
    });
    f.emitData('abcdefgh');
    const a = recordingSink();
    session.attach(a.sink);
    expect(a.output).toEqual(['efgh']);
  });

  it('forwards write, resize and kill to the pty', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 's1',
      pty: f.pty,
      scrollbackBytes: 1000,
      onExit: () => {},
    });
    session.write('ls\n');
    session.resize(80, 24);
    session.kill();
    expect(f.writes).toEqual(['ls\n']);
    expect(f.resizes).toEqual([[80, 24]]);
    expect(f.wasKilled()).toBe(true);
  });

  it('records exit, notifies live sinks, and replays exit to late joiners', () => {
    const f = fakePty();
    const exitHook: Array<number | null> = [];
    const session = createTerminalSession({
      sessionId: 's1',
      pty: f.pty,
      scrollbackBytes: 1000,
      onExit: (c) => exitHook.push(c),
    });
    const live = recordingSink();
    session.attach(live.sink);
    f.emitData('bye');
    f.emitExit(0);
    expect(live.exits).toEqual([0]);
    expect(session.exited).toBe(true);
    expect(session.exitCode).toBe(0);
    expect(exitHook).toEqual([0]);

    const late = recordingSink();
    session.attach(late.sink);
    expect(late.output).toEqual(['bye']);
    expect(late.exits).toEqual([0]);
  });
});
