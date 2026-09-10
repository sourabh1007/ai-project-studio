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
  const resizes: Array<[number, number]> = [];
  return {
    sink: {
      send: (d: string) => output.push(d),
      exit: (c: number | null) => exits.push(c),
      resize: (cols: number, rows: number) => resizes.push([cols, rows]),
    },
    output,
    exits,
    resizes,
  };
}

/** A sink with no optional resize hook, to exercise the absent-hook branch. */
function plainSink() {
  const output: string[] = [];
  return {
    sink: { send: (d: string) => output.push(d), exit: () => {} },
    output,
  };
}

describe('createTerminalSession', () => {
  it('resumes late output when attachment falls between the two ST characters', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 'late-st', pty: f.pty, inputReady: true,
      scrollbackBytes: 4, transcriptBytes: 100, onExit: () => {},
    });
    f.emitData('\x1b]0;hidden');
    f.emitData('\x1b');
    const late = recordingSink();
    session.attach(late.sink);
    f.emitData('\\visible');
    expect(late.output).toEqual(['visible']);
  });

  it.each([0, 4, 100])(
    'preserves a split surrogate when a client attaches between its halves (cap %i)',
    (scrollbackBytes) => {
      const f = fakePty();
      const session = createTerminalSession({
        sessionId: 'late-unicode', pty: f.pty, inputReady: true,
        scrollbackBytes, transcriptBytes: 100, onExit: () => {},
      });
      const live = recordingSink();
      session.attach(live.sink);
      f.emitData('\ud83d');
      const late = recordingSink();
      session.attach(late.sink);
      f.emitData('\ude00visible');
      expect(late.output).toEqual(['😀visible']);
      expect(live.output).toEqual(['\ud83d', '\ude00visible']);
    },
  );

  it.each(['\x1b', '\x1b]0;hidden'])(
    'holds split Unicode while a late joiner is waiting inside %j',
    (prefix) => {
      const f = fakePty();
      const session = createTerminalSession({
        sessionId: 'hidden-unicode', pty: f.pty, inputReady: true,
        scrollbackBytes: 0, transcriptBytes: 100, onExit: () => {},
      });
      f.emitData(prefix);
      const late = recordingSink();
      session.attach(late.sink);
      f.emitData('\ud83d');
      f.emitData('');
      expect(late.output).toEqual([]);
      f.emitData('\ude00' + (prefix === '\x1b' ? '' : '\x07') + 'visible');
      expect(late.output).toEqual(['visible']);
      f.emitData('next');
      expect(late.output).toEqual(['visible', 'next']);
    },
  );

  it.each(['', '\x1b]0;hidden'])(
    'finalizes a late joiner with an incomplete character at EOF in %j',
    (prefix) => {
      const f = fakePty();
      const session = createTerminalSession({
        sessionId: 'eof-unicode', pty: f.pty, inputReady: true,
        scrollbackBytes: 3, transcriptBytes: 100, onExit: () => {},
      });
      f.emitData(prefix + '\ud83d');
      const late = recordingSink();
      session.attach(late.sink);
      f.emitExit(0);
      expect(late.output).toEqual(prefix === '' ? ['\ufffd'] : []);
      expect(late.exits).toEqual([0]);
      const exited = recordingSink();
      session.attach(exited.sink);
      expect(exited.output).toEqual(late.output);
      expect(exited.exits).toEqual([0]);
    },
  );

  it('persists split ANSI/OSC as plain text while keeping live and replay output unchanged', () => {
    const f = fakePty();
    let persisted = '';
    const session = createTerminalSession({
      sessionId: 'split', pty: f.pty, inputReady: true,
      scrollbackBytes: 1000, transcriptBytes: 1000,
      onExit: () => { persisted = session.transcriptText(); },
    });
    const live = recordingSink();
    session.attach(live.sink);
    const chunks = ['\x1b[', '31mred\x1b[0', 'm \x1b]8;;https://example.test', '\x1b',
      '\\link\x1b]8;;', '\x1b\\ ', '\ud83d', '\ude00', '\n'];
    for (const chunk of chunks) f.emitData(chunk);
    expect(live.output).toEqual(chunks);
    const replay = recordingSink();
    session.attach(replay.sink);
    expect(replay.output).toEqual([chunks.join('')]);
    f.emitExit(0);
    expect(persisted).toBe('red link 😀\n');
  });
  it('notifies ready listeners on close, rejects writes/resizes after exit and ignores duplicate exit', () => {
    const f = fakePty();
    const exits: Array<number | null> = [];
    const session = createTerminalSession({
      sessionId: 's1', generation: 42, pty: f.pty, inputReady: true,
      scrollbackBytes: 100, transcriptBytes: 100, onExit: (code) => exits.push(code),
    });
    const states: string[] = [];
    const detach = session.onInputReadiness((state) => states.push(state));
    expect(session.generation).toBe(42);
    f.emitExit(1); f.emitExit(2); session.markInputReady();
    expect(states).toEqual(['ready', 'closed']);
    expect(exits).toEqual([1]);
    expect(session.inputReadiness).toBe('closed');
    expect(() => session.write('no')).toThrow('closed');
    expect(() => session.resize(80, 24)).toThrow('closed');
    expect(f.writes).toEqual([]); expect(f.resizes).toEqual([]);
    detach();
    const closed = session.onInputReadiness((state) => states.push(state));
    closed();
  });
  it('fans live output to attached sinks and accumulates a stripped transcript', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 's1',
      pty: f.pty,
      inputReady: true,
      scrollbackBytes: 1000,
      transcriptBytes: 1000,
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
      inputReady: true,
      scrollbackBytes: 1000,
      transcriptBytes: 1000,
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
      inputReady: true,
      scrollbackBytes: 4,
      transcriptBytes: 1000,
      onExit: () => {},
    });
    f.emitData('abcdefgh');
    const a = recordingSink();
    session.attach(a.sink);
    expect(a.output).toEqual(['efgh']);
  });

  it('bounds retained scrollback by UTF-8 bytes without replaying broken emoji or control tails', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 'utf8-raw',
      pty: f.pty,
      inputReady: true,
      scrollbackBytes: 4,
      transcriptBytes: 1000,
      onExit: () => {},
    });
    f.emitData('a\ud83d');
    f.emitData('\ude00');
    const emoji = recordingSink();
    session.attach(emoji.sink);
    expect(emoji.output).toEqual(['😀']);

    const ansiPty = fakePty();
    const ansi = createTerminalSession({
      sessionId: 'ansi-raw',
      pty: ansiPty.pty,
      inputReady: true,
      scrollbackBytes: 4,
      transcriptBytes: 1000,
      onExit: () => {},
    });
    ansiPty.emitData('\u001b[31mred');
    const replay = recordingSink();
    ansi.attach(replay.sink);
    expect(replay.output).toEqual(['red']);
  });

  it.each([
    {
      name: 'OSC closed by BEL',
      initial: '\u001b]0;' + 'x'.repeat(20),
      continuation: '😀HIDDEN\u0007VISIBLE',
      notifyVisible: [],
      expected: 'VISIBLE',
    },
    {
      name: 'OSC closed by ST',
      initial: '\u001b]0;' + 'x'.repeat(20),
      continuation: 'HIDDEN\u001b\\VISIBLE',
      notifyVisible: [],
      expected: 'VISIBLE',
    },
    {
      name: 'DCS closed by ST',
      initial: '\u001bP' + 'x'.repeat(20),
      continuation: 'HIDDEN\u001b\\VISIBLE',
      notifyVisible: [],
      expected: 'VISIBLE',
    },
    {
      name: 'CSI closed by final byte',
      initial: '\u001b[' + '1'.repeat(20),
      continuation: 'mVISIBLE',
      notifyVisible: ['ote'],
      expected: 'mVISIBLE',
    },
  ])(
    'gates late joiners until a lost $name context closes while existing sinks keep exact raw frames',
    ({ initial, continuation, expected, notifyVisible }) => {
      const f = fakePty();
      const session = createTerminalSession({
        sessionId: 'late-gate',
        pty: f.pty,
        inputReady: true,
        scrollbackBytes: 10,
        transcriptBytes: 1000,
        initialCols: 120,
        initialRows: 30,
        onExit: () => {},
      });
      const live = recordingSink();
      session.attach(live.sink);
      f.emitData(initial);

      const lateA = recordingSink();
      const lateB = recordingSink();
      session.attach(lateA.sink);
      session.attach(lateB.sink);
      expect(lateA.resizes).toEqual([[120, 30]]);
      expect(lateB.resizes).toEqual([[120, 30]]);
      expect(lateA.output).toEqual([]);
      expect(lateB.output).toEqual([]);

      session.notify('note');
      expect(live.output.at(-1)).toBe('note');
      expect(lateA.output).toEqual(notifyVisible);
      expect(lateB.output).toEqual(notifyVisible);

      f.emitData(continuation);
      expect(live.output).toEqual([initial, 'note', continuation]);
      expect(lateA.output).toEqual([...notifyVisible, expected]);
      expect(lateB.output).toEqual([...notifyVisible, expected]);
    },
  );

  it('bounds the retained transcript to transcriptBytes', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 's1',
      pty: f.pty,
      inputReady: true,
      scrollbackBytes: 1000,
      transcriptBytes: 4,
      onExit: () => {},
    });
    f.emitData('abcd');
    f.emitData('efgh');
    expect(session.transcriptText()).toBe('efgh');
  });

  it('bounds the retained transcript by UTF-8 bytes without leaving lone surrogates', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 'utf8-transcript',
      pty: f.pty,
      inputReady: true,
      scrollbackBytes: 1000,
      transcriptBytes: 4,
      onExit: () => {},
    });
    f.emitData('a\ud83d');
    f.emitData('\ude00');
    expect(session.transcriptText()).toBe('😀');
  });

  it('flushes a trailing invalid surrogate only in the exited snapshot', () => {
    const f = fakePty();
    let persisted = '';
    const session = createTerminalSession({
      sessionId: 'invalid-tail',
      pty: f.pty,
      inputReady: true,
      scrollbackBytes: 1000,
      transcriptBytes: 1000,
      onExit: () => {
        persisted = session.transcriptText();
      },
    });
    f.emitData('\ud83d');
    expect(session.transcriptText()).toBe('');
    f.emitExit(0);
    expect(persisted).toBe('\ufffd');
  });

  it('drops replay instead of starting inside an unterminated OSC string', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 'osc-tail',
      pty: f.pty,
      inputReady: true,
      scrollbackBytes: 4,
      transcriptBytes: 1000,
      onExit: () => {},
    });
    f.emitData('\u001b]title-without-end');
    const before = recordingSink();
    session.attach(before.sink);
    expect(before.output).toEqual([]);
    f.emitData('\u001b\\ok');
    const after = recordingSink();
    session.attach(after.sink);
    expect(after.output).toEqual(['ok']);
  });

  it('does not leave late joiners blocked when the process exits during a truncated control string', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 'osc-exit',
      pty: f.pty,
      inputReady: true,
      scrollbackBytes: 10,
      transcriptBytes: 1000,
      onExit: () => {},
    });
    f.emitData('\u001b]0;' + 'x'.repeat(20));
    const late = recordingSink();
    session.attach(late.sink);
    expect(late.output).toEqual([]);
    f.emitExit(0);
    expect(late.exits).toEqual([0]);
  });

  it('activates a pending late joiner when a terminator arrives alone, then forwards later text', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 'terminator-only',
      pty: f.pty,
      inputReady: true,
      scrollbackBytes: 10,
      transcriptBytes: 1000,
      onExit: () => {},
    });
    f.emitData('\u001b]0;' + 'x'.repeat(20));
    const late = recordingSink();
    session.attach(late.sink);
    f.emitData('\u0007');
    expect(late.output).toEqual([]);
    f.emitData('visible');
    expect(late.output).toEqual(['visible']);
  });

  it('with zero replay budget skips history but still forwards later visible output immediately', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 'zero-budget',
      pty: f.pty,
      inputReady: true,
      scrollbackBytes: 0,
      transcriptBytes: 1000,
      onExit: () => {},
    });
    f.emitData('history');
    const late = recordingSink();
    session.attach(late.sink);
    expect(late.output).toEqual([]);
    f.emitData('visible');
    expect(late.output).toEqual(['visible']);
  });

  it('emits the capture size to a resize-capable sink before replaying, and tracks resizes', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 's1',
      pty: f.pty,
      inputReady: true,
      scrollbackBytes: 1000,
      transcriptBytes: 1000,
      initialCols: 120,
      initialRows: 30,
      onExit: () => {},
    });
    f.emitData('history');

    const first = recordingSink();
    session.attach(first.sink);
    // Capture size arrives before the scrollback so the client can size its grid.
    expect(first.resizes).toEqual([[120, 30]]);
    expect(first.output).toEqual(['history']);

    // A resize updates the tracked capture size forwarded to later joiners, and
    // still reaches the PTY.
    session.resize(80, 24);
    expect(f.resizes).toEqual([[80, 24]]);
    const late = recordingSink();
    session.attach(late.sink);
    expect(late.resizes).toEqual([[80, 24]]);
  });

  it('replays without error to a sink that omits the optional resize hook', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 's1',
      pty: f.pty,
      inputReady: true,
      scrollbackBytes: 1000,
      transcriptBytes: 1000,
      initialCols: 100,
      initialRows: 40,
      onExit: () => {},
    });
    f.emitData('past');
    const plain = plainSink();
    session.attach(plain.sink);
    expect(plain.output).toEqual(['past']);
  });

  it('forwards write, resize and kill to the pty', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 's1',
      pty: f.pty,
      inputReady: true,
      scrollbackBytes: 1000,
      transcriptBytes: 1000,
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
      inputReady: true,
      scrollbackBytes: 1000,
      transcriptBytes: 1000,
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

  it('displays a notice to live sinks and replays it, bounded to scrollback', () => {
    const f = fakePty();
    const session = createTerminalSession({
      sessionId: 's1',
      pty: f.pty,
      inputReady: true,
      scrollbackBytes: 4,
      transcriptBytes: 1000,
      onExit: () => {},
    });
    const live = recordingSink();
    session.attach(live.sink);
    session.notify('retrying');
    // Sent to the live sink, but kept out of the CLI transcript.
    expect(live.output).toEqual(['retrying']);
    expect(session.transcriptText()).toBe('');
    // Retained (bounded) scrollback replays to a late joiner.
    const late = recordingSink();
    session.attach(late.sink);
    expect(late.output).toEqual(['ying']);
  });

  describe('suppressOutput', () => {
    function suppressible() {
      const output: string[] = [];
      return {
        sink: {
          suppressible: true,
          send: (d: string) => output.push(d),
          exit: () => {},
        },
        output,
      };
    }

    function build(scrollbackBytes = 1000) {
      const f = fakePty();
      const session = createTerminalSession({
        sessionId: 's1',
        pty: f.pty,
        inputReady: true,
        scrollbackBytes,
        transcriptBytes: 1000,
        onExit: () => {},
      });
      return { f, session };
    }

    it('hides output from watchers while keeping internal observers fed', () => {
      const { f, session } = build();
      const watcher = suppressible();
      const observer = recordingSink();
      session.attach(watcher.sink);
      session.attach(observer.sink);

      const release = session.suppressOutput('applying');
      f.emitData('injected echo');
      release();
      f.emitData('after');

      // The watcher sees the status line and the post-release output only.
      expect(watcher.output).toEqual(['applying', 'after']);
      // Internal observers must keep seeing everything, or the very logic that
      // ends suppression (quiet detection) would never fire.
      expect(observer.output).toEqual(['applying', 'injected echo', 'after']);
    });

    it('keeps hidden output out of scrollback but in the transcript', () => {
      const { f, session } = build();
      const release = session.suppressOutput();
      f.emitData('hidden');
      release();
      f.emitData('shown');

      const late = suppressible();
      session.attach(late.sink);
      expect(late.output).toEqual(['shown']);
      // Summaries still see the applied context even though the user does not.
      expect(session.transcriptText()).toBe('hiddenshown');
    });

    it('only resumes once every overlapping hold is released', () => {
      const { f, session } = build();
      const watcher = suppressible();
      session.attach(watcher.sink);

      const outer = session.suppressOutput();
      const inner = session.suppressOutput();
      inner();
      f.emitData('still hidden');
      outer();
      f.emitData('visible');

      expect(watcher.output).toEqual(['visible']);
    });

    it('ignores a repeated release so it cannot un-hide another hold', () => {
      const { f, session } = build();
      const watcher = suppressible();
      session.attach(watcher.sink);

      const first = session.suppressOutput();
      const second = session.suppressOutput();
      first();
      first();
      f.emitData('hidden');
      second();
      f.emitData('visible');

      expect(watcher.output).toEqual(['visible']);
    });

    it('skips an empty notice', () => {
      const { session } = build();
      const watcher = suppressible();
      session.attach(watcher.sink);
      session.suppressOutput('')();
      expect(watcher.output).toEqual([]);
    });
  });

  it('settles pending input readiness as ready or closed exactly once', () => {
    const readyPty = fakePty();
    const session = createTerminalSession({
      sessionId: 's1',
      pty: readyPty.pty,
      inputReady: false,
      scrollbackBytes: 1000,
      transcriptBytes: 1000,
      onExit: () => {},
    });
    const states: string[] = [];
    const detach = session.onInputReadiness((state) => states.push(state));
    expect(session.inputReadiness).toBe('pending');
    session.markInputReady();
    session.markInputReady();
    expect(states).toEqual(['ready']);
    expect(session.inputReadiness).toBe('ready');
    detach();

    const immediate: string[] = [];
    session.onInputReadiness((state) => immediate.push(state));
    expect(immediate).toEqual(['ready']);

    const closedPty = fakePty();
    const closed = createTerminalSession({
      sessionId: 's2',
      pty: closedPty.pty,
      inputReady: false,
      scrollbackBytes: 1000,
      transcriptBytes: 1000,
      onExit: () => {},
    });
    const closedStates: string[] = [];
    closed.onInputReadiness((state) => closedStates.push(state));
    closedPty.emitExit(1);
    expect(closedStates).toEqual(['closed']);
    expect(closed.inputReadiness).toBe('closed');
    closed.markInputReady();
    expect(closed.inputReadiness).toBe('closed');
  });
});
