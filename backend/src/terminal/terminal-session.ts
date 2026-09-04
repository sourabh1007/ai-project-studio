import type { PtyProcess } from './pty-contract.js';
import { stripAnsi } from './ansi.js';

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
}

export interface TerminalSessionDeps {
  sessionId: string;
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
  /** Writes raw bytes to the terminal; transports enforce input readiness. */
  write(data: string): void;
  /**
   * Current input readiness. Bootstrap seeding uses raw writes while browser
   * input waits for this state to become `ready`.
   */
  readonly inputReadiness: 'pending' | 'ready' | 'closed';
  /** Observes the transition out of `pending`; settled states fire immediately. */
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
  let cols = deps.initialCols ?? 0;
  let rows = deps.initialRows ?? 0;
  let scrollback = '';
  let transcript = '';
  let exited = false;
  let exitCode: number | null = null;
  let inputReadiness: 'pending' | 'ready' | 'closed' = deps.inputReady
    ? 'ready'
    : 'pending';
  const readinessListeners = new Set<
    (state: 'ready' | 'closed') => void
  >();

  const settleInputReadiness = (state: 'ready' | 'closed'): void => {
    if (inputReadiness !== 'pending') {
      return;
    }
    inputReadiness = state;
    for (const listener of readinessListeners) {
      listener(state);
    }
    readinessListeners.clear();
  };

  pty.onData((data) => {
    scrollback += data;
    if (scrollback.length > scrollbackBytes) {
      scrollback = scrollback.slice(scrollback.length - scrollbackBytes);
    }
    transcript += stripAnsi(data);
    if (transcript.length > transcriptBytes) {
      transcript = transcript.slice(transcript.length - transcriptBytes);
    }
    for (const sink of sinks) {
      sink.send(data);
    }
  });

  pty.onExit((code) => {
    exited = true;
    exitCode = code;
    settleInputReadiness('closed');
    for (const sink of sinks) {
      sink.exit(code);
    }
    deps.onExit(code);
  });

  return {
    sessionId,
    write: (data) => pty.write(data),
    get inputReadiness() {
      return inputReadiness;
    },
    onInputReadiness(listener) {
      if (inputReadiness !== 'pending') {
        listener(inputReadiness);
        return () => {};
      }
      readinessListeners.add(listener);
      return () => readinessListeners.delete(listener);
    },
    markInputReady: () => settleInputReadiness('ready'),
    resize: (nextCols, nextRows) => {
      cols = nextCols;
      rows = nextRows;
      pty.resize(nextCols, nextRows);
    },
    attach(sink) {
      // Tell the client the capture size before replaying, so it can match its
      // grid width to the scrollback and avoid garbled/overlapping redraws.
      sink.resize?.(cols, rows);
      if (scrollback.length > 0) {
        sink.send(scrollback);
      }
      if (exited) {
        sink.exit(exitCode);
      }
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
      };
    },
    kill: () => pty.kill(),
    notify(text) {
      scrollback += text;
      if (scrollback.length > scrollbackBytes) {
        scrollback = scrollback.slice(scrollback.length - scrollbackBytes);
      }
      for (const sink of sinks) {
        sink.send(text);
      }
    },
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    transcriptText: () => transcript,
  };
}
