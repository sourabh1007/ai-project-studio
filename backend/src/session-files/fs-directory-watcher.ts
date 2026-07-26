import { watch, existsSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type {
  DirectoryChange,
  DirectoryWatch,
  DirectoryWatcherFactory,
} from './session-files-contract.js';

/** Coalesce window (ms) so a burst of writes to one file emits once. */
const DEBOUNCE_MS = 150;

/**
 * fs-backed {@link DirectoryWatcherFactory}. Watches `root` recursively and maps
 * raw fs events to {@link DirectoryChange}s: a path seen for the first time is an
 * 'add', a subsequent event on it is a 'change'. Directories and deletions are
 * dropped. This is the only filesystem-aware piece; the tracker logic that
 * consumes it is unit-tested against a fake factory.
 */
export const createFsDirectoryWatcher: DirectoryWatcherFactory = (
  root: string,
  onChange: (change: DirectoryChange) => void,
): DirectoryWatch => {
  const seen = new Set<string>();
  const timers = new Map<string, NodeJS.Timeout>();

  function resolve(filename: string): string {
    return isAbsolute(filename) ? filename : join(root, filename);
  }

  function flush(path: string): void {
    timers.delete(path);
    if (!existsSync(path)) {
      seen.delete(path);
      return;
    }
    try {
      if (!statSync(path).isFile()) {
        return;
      }
    } catch {
      return;
    }
    const kind: DirectoryChange['kind'] = seen.has(path) ? 'change' : 'add';
    seen.add(path);
    onChange({ path, kind });
  }

  function schedule(path: string): void {
    const existing = timers.get(path);
    if (existing) {
      clearTimeout(existing);
    }
    timers.set(
      path,
      setTimeout(() => flush(path), DEBOUNCE_MS),
    );
  }

  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) {
        return;
      }
      schedule(resolve(filename.toString()));
    });
    watcher.on('error', () => {});
  } catch {
    // A missing or unwatchable root degrades to a no-op watch.
  }

  return {
    close() {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      watcher?.close();
    },
  };
};
