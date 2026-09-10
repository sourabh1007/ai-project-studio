import type { PtyProcess } from './pty-contract.js';
import { createAnsiParser, createAnsiStripper, type AnsiParser } from './ansi.js';
import {
  createAnsiSafeUtf8TailBuffer,
  createUtf8TailBuffer,
  isHighSurrogate,
  nextUtf8Unit,
  type TerminalReplayBuffer,
} from './terminal-local-buffer.js';

/** A connected client that receives terminal output and the final exit code. */
export interface TerminalOutputSink {
  send(data: string): void;
  exit(code: number | null): void;
  /**
   * Optional. Invoked once on attach — before any scrollback replay — with the
   * PTY's current viewport size. Lets a (re)connecting client size its terminal
   * grid to the exact width the retained scrollback was rendered at, so the
   * replayed full-screen TUI output stays aligned instead of garbling when the
   * client's pane width differs from the capture width.
   */
  resize?(cols: number, rows: number): void;
  /**
   * Marks this sink as one a user is watching, so it is muted while output is
   * suppressed (see {@link TerminalSession.suppressOutput}). Internal observers
   * leave it unset and keep receiving everything.
   */
  suppressible?: boolean;
}

export interface TerminalSessionDeps {
  sessionId: string;
  generation?: number;
  pty: PtyProcess;
  /** Whether browser input may be forwarded immediately. */
  inputReady: boolean;
  /** Max bytes of raw output retained for replay to late-joining clients. */
  scrollbackBytes: number;
  /**
   * Max bytes of ANSI-stripped transcript retained for persistence /
   * summarization. Bounds heap growth for long-lived interactive sessions the
   * same way {@link scrollbackBytes} bounds scrollback; the oldest text is
   * dropped once the cap is exceeded.
   */
  transcriptBytes: number;
  /**
   * The PTY's initial viewport size, mirrored back to reconnecting clients on
   * attach so they can render retained scrollback at its capture width. Updated
   * as the client resizes; defaults to 0 (unknown) when not supplied.
   */
  initialCols?: number;
  initialRows?: number;
  /** Invoked once when the underlying process exits. */
  onExit: (code: number | null) => void;
}

export interface TerminalSession {
  readonly sessionId: string;
  readonly generation: number;
  /** Writes raw bytes to the terminal; transports enforce input readiness. */
  write(data: string): void;
  /**
   * Current input readiness. Bootstrap seeding uses raw writes while browser
   * input waits for this state to become `ready`.
   */
  readonly inputReadiness: 'pending' | 'ready' | 'closed';
  /** Observes readiness including ready → closed; current settled state fires immediately. */
  onInputReadiness(
    listener: (state: 'ready' | 'closed') => void,
  ): () => void;
  /** Allows browser input after launch-time bootstrap injection completes. */
  markInputReady(): void;
  /** Resizes the terminal viewport. */
  resize(cols: number, rows: number): void;
  /**
   * Attaches a client sink. Immediately replays retained scrollback (and the
   * exit, if already ended). Returns a detach function.
   */
  attach(sink: TerminalOutputSink): () => void;
  /** Terminates the terminal process. */
  kill(): void;
  /**
   * Displays IDE-injected text to every attached client (and retained
   * scrollback) without sending it to the PTY. Used for surfacing notices such
   * as an automatic retry; kept out of the transcript so summaries reflect only
   * the CLI's own output.
   */
  notify(text: string): void;
  /**
   * Hides PTY output from clients and scrollback until the returned release is
   * called, showing `notice` in its place.
   *
   * Applying workspace/skill context types the whole instruction block into the
   * terminal, so the user watched a wall of injected text scroll past that they
   * had not written and could not act on. Suppressing the echo turns it into a
   * one-line "context is getting applied" status. The transcript still records
   * everything, so summaries are unaffected. Release is idempotent, and callers
   * must guarantee it runs on every path or the session would go silent.
   */
  suppressOutput(notice?: string): () => void;
  readonly exited: boolean;
  readonly exitCode: number | null;
  /** ANSI-stripped accumulated output, for persistence / summarization. */
  transcriptText(): string;
}

/**
 * Orchestrates one interactive PTY session: bounded scrollback, output fan-out
 * to any number of attached clients, input/resize forwarding, exit tracking and
 * a plain-text transcript. Pure logic over the {@link PtyProcess} port.
 */
export function createTerminalSession(
  deps: TerminalSessionDeps,
): TerminalSession {
  const { sessionId, pty, scrollbackBytes, transcriptBytes } = deps;
  const sinks = new Set<TerminalOutputSink>();
  const pendingSinks = new Map<TerminalOutputSink, {
    parser: AnsiParser;
    highSurrogate: string | null;
  }>();
  let cols = deps.initialCols ?? 0;
  let rows = deps.initialRows ?? 0;
  const scrollback: TerminalReplayBuffer =
    createAnsiSafeUtf8TailBuffer(scrollbackBytes);
  const transcript = createUtf8TailBuffer(transcriptBytes);
  const stripTranscriptAnsi = createAnsiStripper();
  let exited = false;
  let exitCode: number | null = null;
  /**
   * Number of active output-suppression holds. While positive, PTY output is
   * kept out of the visible stream and scrollback (but not the transcript).
   * A counter rather than a flag so overlapping injections cannot have the
   * inner one un-hide the outer one's echo.
   */
  let suppressDepth = 0;
  let inputReadiness: 'pending' | 'ready' | 'closed' = deps.inputReady
    ? 'ready'
    : 'pending';
  const readinessListeners = new Set<
    (state: 'ready' | 'closed') => void
  >();

  const settleInputReadiness = (state: 'ready' | 'closed'): void => {
    if (inputReadiness === state || inputReadiness === 'closed') {
      return;
    }
    inputReadiness = state;
    for (const listener of readinessListeners) {
      listener(state);
    }
    if (state === 'closed') readinessListeners.clear();
  };

  const sendToNewlyReadySinks = (data: string): void => {
    if (pendingSinks.size === 0 || data.length === 0) {
      return;
    }
    for (const [sink, pending] of pendingSinks) {
      const { parser } = pending;
      const input = (pending.highSurrogate ?? '') + data;
      pending.highSurrogate = null;
      let index = 0;
      while (index < input.length && !parser.atTextBoundary()) {
        if (isHighSurrogate(input.charCodeAt(index)) && index + 1 === input.length) {
          pending.highSurrogate = input[index];
          break;
        }
        const unit = nextUtf8Unit(input, index);
        parser.write(unit);
        index += unit.length;
      }
      if (!parser.atTextBoundary()) {
        continue;
      }
      pendingSinks.delete(sink);
      sinks.add(sink);
      if (index < input.length) {
        sink.send(input.slice(index));
      }
    }
  };

  pty.onData((data) => {
    // The transcript always records, even while the echo of an injected
    // instruction block is hidden: summarization should still see the context
    // that was applied, the user just should not have to read it scroll past.
    transcript.append(stripTranscriptAnsi(data));
    const hidden = suppressDepth > 0;
    if (!hidden) {
      scrollback.append(data);
    }
    for (const sink of sinks) {
      // Internal observers (quiet detection, retry analysis, MCP watching) must
      // keep seeing output while it is hidden, or suppression would stall the
      // very logic that ends it.
      if (hidden && sink.suppressible) continue;
      sink.send(data);
    }
    if (!hidden) {
      sendToNewlyReadySinks(data);
    }
  });

  pty.onExit((code) => {
    if (exited) return;
    exited = true;
    exitCode = code;
    scrollback.finalize();
    transcript.finalize();
    settleInputReadiness('closed');
    for (const sink of sinks) {
      sink.exit(code);
    }
    for (const [sink, pending] of pendingSinks) {
      if (pending.highSurrogate !== null && pending.parser.atTextBoundary()) {
        sink.send('\ufffd');
      }
      sink.exit(code);
    }
    pendingSinks.clear();
    deps.onExit(code);
  });

  return {
    sessionId,
    generation: deps.generation ?? 1,
    write: (data) => {
      if (inputReadiness === 'closed') throw new Error('Terminal is closed');
      pty.write(data);
    },
    get inputReadiness() {
      return inputReadiness;
    },
    onInputReadiness(listener) {
      if (inputReadiness !== 'pending') {
        listener(inputReadiness);
      }
      if (inputReadiness === 'closed') return () => {};
      readinessListeners.add(listener);
      return () => readinessListeners.delete(listener);
    },
    markInputReady: () => settleInputReadiness('ready'),
    resize: (nextCols, nextRows) => {
      if (inputReadiness === 'closed') throw new Error('Terminal is closed');
      cols = nextCols;
      rows = nextRows;
      pty.resize(nextCols, nextRows);
    },
    attach(sink) {
      // Tell the client the capture size before replaying, so it can match its
      // grid width to the scrollback and avoid garbled/overlapping redraws.
      sink.resize?.(cols, rows);
      const retained = scrollback.text();
      if (retained.length > 0) {
        sink.send(retained);
      }
      if (exited) {
        sink.exit(exitCode);
        return () => {};
      }
      const lateJoinState = scrollback.lateJoinState();
      const highSurrogate = scrollback.pendingHighSurrogate();
      if (lateJoinState || highSurrogate !== null) {
        pendingSinks.set(sink, {
          parser: createAnsiParser(lateJoinState ?? undefined),
          highSurrogate,
        });
      } else {
        sinks.add(sink);
      }
      return () => {
        sinks.delete(sink);
        pendingSinks.delete(sink);
      };
    },
    kill: () => {
      settleInputReadiness('closed');
      pty.kill();
    },
    notify(text) {
      scrollback.append(text);
      for (const sink of sinks) {
        sink.send(text);
      }
      sendToNewlyReadySinks(text);
    },
    suppressOutput(notice) {
      if (notice !== undefined && notice.length > 0) {
        // Show the status line before the hold starts, so it is visible even
        // though everything after it is hidden.
        scrollback.append(notice);
        for (const sink of sinks) {
          sink.send(notice);
        }
        sendToNewlyReadySinks(notice);
      }
      suppressDepth += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        suppressDepth -= 1;
      };
    },
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    transcriptText: () => transcript.text(),
  };
}
