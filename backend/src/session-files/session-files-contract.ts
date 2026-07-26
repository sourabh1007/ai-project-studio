/**
 * Contracts for tracking the files a session created or edited. Rather than
 * relying on what a particular CLI happens to log (the plain `copilot`/agency
 * invocations the app spawns do not record file activity), we watch each
 * session's working directory ourselves and persist the touched files. This
 * keeps the feature provider-agnostic — any tool driven through a terminal
 * benefits without special integration.
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

/** A filesystem change observed under a watched root. */
export interface DirectoryChange {
  /** Absolute path of the changed file. */
  path: string;
  /** 'add' for a newly created file, 'change' for a modification. */
  kind: 'add' | 'change';
}

/** A handle to a live recursive watch on one directory. */
export interface DirectoryWatch {
  close(): void;
}

/**
 * Creates a recursive watch on `root`, invoking `onChange` for each observed
 * file change. Isolated behind a port so the tracker is testable without real
 * filesystem events; the fs-backed adapter is the only IO-aware piece.
 */
export type DirectoryWatcherFactory = (
  root: string,
  onChange: (change: DirectoryChange) => void,
) => DirectoryWatch;

/**
 * Tracks which session is responsible for filesystem changes under a working
 * directory. Sessions sharing a directory are disambiguated by recency of
 * activity: the session most recently typed into (or, absent input, most
 * recently opened) owns incoming changes.
 */
export interface SessionFileTracker {
  /** Begins attributing changes under `root` to `sessionId`. */
  open(sessionId: string, root: string): void;
  /** Marks `sessionId` as the active writer for its root (e.g. on input). */
  markActive(sessionId: string): void;
  /** Stops attributing changes to `sessionId`, releasing its root if idle. */
  close(sessionId: string): void;
}
