import type { PtyProcess } from './pty-contract.js';
import { stripAnsi } from './ansi.js';

/** A connected client that receives terminal output and the final exit code. */
export interface TerminalOutputSink {
  send(data: string): void;
  exit(code: number | null): void;
}

export interface TerminalSessionDeps {
  sessionId: string;
  pty: PtyProcess;
  /** Max bytes of raw output retained for replay to late-joining clients. */
  scrollbackBytes: number;
  /** Invoked once when the underlying process exits. */
  onExit: (code: number | null) => void;
}

export interface TerminalSession {
  readonly sessionId: string;
  /** Sends user keystrokes to the terminal. */
  write(data: string): void;
  /** Resizes the terminal viewport. */
  resize(cols: number, rows: number): void;
  /**
   * Attaches a client sink. Immediately replays retained scrollback (and the
   * exit, if already ended). Returns a detach function.
   */
  attach(sink: TerminalOutputSink): () => void;
  /** Terminates the terminal process. */
  kill(): void;
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
  const { sessionId, pty, scrollbackBytes } = deps;
  const sinks = new Set<TerminalOutputSink>();
  let scrollback = '';
  let transcript = '';
  let exited = false;
  let exitCode: number | null = null;

  pty.onData((data) => {
    scrollback += data;
    if (scrollback.length > scrollbackBytes) {
      scrollback = scrollback.slice(scrollback.length - scrollbackBytes);
    }
    transcript += stripAnsi(data);
    for (const sink of sinks) {
      sink.send(data);
    }
  });

  pty.onExit((code) => {
    exited = true;
    exitCode = code;
    for (const sink of sinks) {
      sink.exit(code);
    }
    deps.onExit(code);
  });

  return {
    sessionId,
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    attach(sink) {
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
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    transcriptText: () => transcript,
  };
}
