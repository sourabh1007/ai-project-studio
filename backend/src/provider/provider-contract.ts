/** Contract shared by all AI provider adapters (Copilot, Agency, ...). */

import type {
  SessionOutputScanner,
  SessionOutputScannerContext,
} from '../session-files/session-files-contract.js';

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

/**
 * A past session that lives in a provider's own store (e.g. the CLI's
 * `session-store.db`) and can be imported into a workspace feature. Kept
 * provider-agnostic so every provider surfaces its history the same way.
 */
export interface ImportableSession {
  /** The provider-native session id (becomes the imported Session id). */
  externalId: string;
  /** Provider that owns this session (filled in by the provider). */
  provider: string;
  /** Human-friendly title: the CLI summary, first message, or a fallback. */
  title: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  /** Last model used in the session, if known. */
  model: string | null;
  /** Number of recorded turns/messages. */
  messageCount: number;
  createdAt: string;
  updatedAt: string;
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
  /**
   * Optional capability: builds a scanner that detects files the tool creates
   * or edits from its interactive terminal output. Providers whose CLI
   * announces file operations implement it; others omit it and contribute no
   * tracked files, keeping the terminal module tool-agnostic.
   */
  createOutputScanner?(ctx: SessionOutputScannerContext): SessionOutputScanner;
  /**
   * Optional capability: lists past sessions from this provider's own store
   * that can be imported into a feature. Providers without an accessible
   * history simply omit it; the import service skips them.
   */
  listImportableSessions?(): ImportableSession[];
}
