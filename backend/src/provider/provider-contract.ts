/** Contract shared by all AI provider adapters (Copilot, Agency, ...). */

/** A model offered by a provider. */
export interface ModelInfo {
  id: string;
  label: string;
}

export type SessionKind = 'dev' | 'meta';

/** Everything needed to launch one AI session through a provider. */
export interface SessionSpec {
  sessionId: string;
  featureId: string;
  prompt: string;
  /** Model id, or 'auto' to let the provider choose. */
  model: string;
  kind: SessionKind;
  /** Absolute path where the provider must write its OTel usage JSONL. */
  otelFilePath: string;
  cwd?: string;
}

/** Streaming events emitted while a session runs. */
export type SessionEvent =
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; line: string }
  | { type: 'exit'; code: number | null };

/**
 * A fully-resolved command to run a provider's CLI *interactively* inside a
 * pseudo-terminal. Unlike {@link SessionSpec}-driven one-shot runs, this keeps
 * the native chat TUI so the user gets the real CLI experience. Usage is still
 * captured because `env` carries the same OTel wiring.
 */
export interface InteractiveCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Handle to a session that is currently running. */
export interface RunningSession {
  readonly sessionId: string;
  onEvent(handler: (event: SessionEvent) => void): void;
  kill(): void;
  /** Resolves with the process exit code when the session ends. */
  readonly done: Promise<number | null>;
}

/** A pluggable AI provider. Adding one requires only a new implementation. */
export interface IAIProvider {
  readonly id: string;
  listModels(): Promise<ModelInfo[]>;
  startSession(spec: SessionSpec): RunningSession;
  /**
   * Builds the command/env to run this provider interactively in a PTY. Adding
   * a new provider only requires implementing this — the terminal module stays
   * provider-agnostic (open/closed).
   */
  buildInteractiveCommand(spec: SessionSpec): InteractiveCommand;
}
