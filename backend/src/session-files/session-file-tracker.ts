import type {
  DirectoryChange,
  DirectoryWatch,
  DirectoryWatcherFactory,
  SessionFilesStore,
  SessionFileTracker,
} from './session-files-contract.js';

/** Collaborators for {@link createSessionFileTracker}. */
export interface SessionFileTrackerDeps {
  /** Where observed files are persisted. */
  store: SessionFilesStore;
  /** Creates a recursive watch for a working directory. */
  watcherFactory: DirectoryWatcherFactory;
  /** Supplies the timestamp recorded for a change. */
  now: () => string;
  /** Returns true for paths that should be ignored (build output, VCS, etc.). */
  ignore: (path: string) => boolean;
}

interface RootState {
  /** Sessions on this root, most-recently-active first. */
  sessions: string[];
  watch: DirectoryWatch;
}

/**
 * Attributes filesystem changes to sessions. Multiple sessions can share one
 * working directory, so a change is credited to that directory's most recently
 * active session — the one most recently typed into, or, absent input, most
 * recently opened. One recursive watch is shared per directory and closed once
 * its last session ends.
 */
export function createSessionFileTracker(
  deps: SessionFileTrackerDeps,
): SessionFileTracker {
  const { store, watcherFactory, now, ignore } = deps;
  const roots = new Map<string, RootState>();
  const sessionRoot = new Map<string, string>();

  function handleChange(root: string, change: DirectoryChange): void {
    if (ignore(change.path)) {
      return;
    }
    const state = roots.get(root);
    const sessionId = state?.sessions[0];
    if (!sessionId) {
      return;
    }
    const tool = change.kind === 'add' ? 'create' : 'edit';
    store.record(sessionId, change.path, tool, now());
  }

  function moveToFront(sessions: string[], sessionId: string): void {
    const index = sessions.indexOf(sessionId);
    if (index > 0) {
      sessions.splice(index, 1);
      sessions.unshift(sessionId);
    }
  }

  return {
    open(sessionId, root) {
      const previousRoot = sessionRoot.get(sessionId);
      if (previousRoot === root) {
        moveToFront(roots.get(root)!.sessions, sessionId);
        return;
      }
      if (previousRoot !== undefined) {
        this.close(sessionId);
      }
      sessionRoot.set(sessionId, root);
      const existing = roots.get(root);
      if (existing) {
        existing.sessions.unshift(sessionId);
        return;
      }
      const watch = watcherFactory(root, (change) => handleChange(root, change));
      roots.set(root, { sessions: [sessionId], watch });
    },
    markActive(sessionId) {
      const root = sessionRoot.get(sessionId);
      if (root === undefined) {
        return;
      }
      moveToFront(roots.get(root)!.sessions, sessionId);
    },
    close(sessionId) {
      const root = sessionRoot.get(sessionId);
      if (root === undefined) {
        return;
      }
      sessionRoot.delete(sessionId);
      const state = roots.get(root)!;
      state.sessions = state.sessions.filter((id) => id !== sessionId);
      if (state.sessions.length === 0) {
        state.watch.close();
        roots.delete(root);
      }
    },
  };
}
