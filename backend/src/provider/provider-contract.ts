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

/**
 * Stateful scanner over a session's terminal output that detects when the
 * active model changes mid-session inside the interactive CLI. Fed successive
 * (raw) output chunks, it buffers partial lines and returns the model id(s)
 * newly announced by each chunk, in order. The announcement format is a
 * CLI-specific detail, so this is provided by the provider; providers whose CLI
 * emits no such line omit the hook and the resolved model is only derived from
 * usage rows.
 */
export interface ModelChangeScanner {
  feed(chunk: string): string[];
}

/** Everything needed to launch one AI session through a provider. */
export interface SessionSpec {
  sessionId: string;
  featureId: string;
  prompt: string;
  /** Absolute paths attached to the session's initial prompt. */
  attachments?: readonly string[];
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

/**
 * Optional MCP (Model Context Protocol) capability for a provider. Because the
 * MCP config file's location and format are CLI-specific, providers that expose
 * MCP servers implement this so the core MCP module stays provider-agnostic.
 * The file path is discovered at runtime through a provider meta-session rather
 * than hardcoded; {@link defaultConfigPath} is only a documented fallback used
 * when that discovery yields nothing.
 */
export interface McpSupport {
  /**
   * Prompt asking this provider's own CLI (run headlessly) to print the
   * absolute path of its MCP configuration file. Keeping the phrasing on the
   * provider avoids guessing where each CLI stores its config.
   */
  readonly configPathPrompt: string;
  /**
   * Extracts an absolute config-file path from the CLI's meta-session reply, or
   * null when no path can be found (the caller then falls back).
   */
  parseConfigPath(reply: string): string | null;
  /** Documented default config path used when dynamic discovery yields nothing. */
  defaultConfigPath(): string;
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
   * Optional capability: builds a scanner that detects mid-session model
   * switches from the interactive terminal output (e.g. the CLI's
   * `Model changed … to <model>` status line), so the resolved model shown in
   * the UI tracks the CLI immediately rather than only after the next usage row
   * is recorded. Providers whose CLI emits no such line omit it.
   */
  createModelChangeScanner?(): ModelChangeScanner;
  /**
   * Optional capability: lists past sessions from this provider's own store
   * that can be imported into a feature. Providers without an accessible
   * history simply omit it; the import service skips them.
   */
  listImportableSessions?(): ImportableSession[];
  /**
   * Optional capability: exposes the provider's MCP server configuration so the
   * IDE can list and edit it. Providers without MCP support omit it and are
   * hidden from the MCP management surface.
   */
  readonly mcp?: McpSupport;
}
