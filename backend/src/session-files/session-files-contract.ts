/**
 * Contracts for tracking the files a session created or edited.
 *
 * The CLI stores nothing structured about file operations for the sessions this
 * app spawns, and a session can write files anywhere on disk — not just under
 * its working directory — so watching the filesystem is both incomplete and
 * prone to mis-attribution. Instead we read the authoritative source: the tool
 * announces each file it creates/edits in its own output (e.g. `Created
 * C:\path\file.md`). Each PTY belongs to exactly one session, so parsing that
 * output attributes every file op to the right session with no ambiguity.
 *
 * The parsing patterns are provider-specific and supplied by the provider (see
 * {@link SessionOutputScannerFactory}), keeping the IDE tool-agnostic: a
 * provider without a scanner simply contributes no files.
 */

/** How a file was touched within a session. */
export type SessionFileTool = 'create' | 'edit';

/** A single file a session created or edited. */
export interface SessionFile {
  /** Absolute path exactly as observed on disk. */
  path: string;
  /** Basename of {@link path} for display. */
  name: string;
  /** Directory portion of {@link path}, shown as secondary/hover text. */
  dir: string;
  /** Whether the file was newly created or edited during the session. */
  tool: SessionFileTool;
  /** ISO timestamp the file was first seen changing in the session. */
  firstSeenAt: string;
}

/** Persistence for the files observed per session. */
export interface SessionFilesStore {
  /**
   * Records that `path` was touched by `sessionId` with `tool` at `at`. The
   * first sighting of a path wins its `firstSeenAt`; a later `create` upgrades a
   * prior `edit` (a file can be edited-then-reported-created out of order).
   */
  record(sessionId: string, path: string, tool: SessionFileTool, at: string): void;
  /** Files for a session, newest first. */
  list(sessionId: string): SessionFile[];
  /** Removes all files recorded for a session (used when a session is deleted). */
  deleteBySession(sessionId: string): void;
}

/** A file operation detected in a session's terminal output. */
export interface SessionFileOp {
  /** Absolute path of the affected file. */
  path: string;
  /** Whether the operation created or edited the file. */
  tool: SessionFileTool;
}

/**
 * Stateful scanner over a session's terminal output. Fed successive (already
 * ANSI-stripped) chunks, it buffers partial lines and returns any file
 * operations completed by each chunk.
 */
export interface SessionOutputScanner {
  feed(chunk: string): SessionFileOp[];
}

/** Context a scanner needs to resolve tool-printed paths to absolute paths. */
export interface SessionOutputScannerContext {
  /** The user's home directory, for expanding `~`-relative paths. */
  home: string;
  /** The session's working directory, for resolving relative paths. */
  cwd?: string;
}

/** Builds a {@link SessionOutputScanner} bound to a resolution context. */
export type SessionOutputScannerFactory = (
  ctx: SessionOutputScannerContext,
) => SessionOutputScanner;
