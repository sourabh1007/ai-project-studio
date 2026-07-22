/**
 * Port for spawning pseudo-terminals. The real implementation wraps the native
 * `node-pty` module (see node-pty-spawner.ts); the terminal module depends only
 * on this interface so its orchestration logic stays fully unit-testable.
 */

export interface PtySpawnRequest {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  cols: number;
  rows: number;
}

/** Handle to a live pseudo-terminal process. */
export interface PtyProcess {
  /** Writes user input (keystrokes) to the terminal. */
  write(data: string): void;
  /** Resizes the terminal viewport. */
  resize(cols: number, rows: number): void;
  /** Subscribes to terminal output (already includes ANSI control codes). */
  onData(cb: (data: string) => void): void;
  /** Fires once when the underlying process exits. */
  onExit(cb: (code: number | null) => void): void;
  /** Terminates the terminal process. */
  kill(): void;
}

export interface PtySpawner {
  spawn(request: PtySpawnRequest): PtyProcess;
}
