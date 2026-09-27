import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import type { ResourcesConfig } from './config.js';
import type {
  ResourceFileSystem, StorageCategory, StorageRoot, StorageSnapshot,
} from './resources-contract.js';

export const canonicalPath = (path: string): string => {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};
export function isWithin(path: string, directory: string): boolean {
  const rel = relative(canonicalPath(directory), canonicalPath(path));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const categoryDefinitions = [
  ['logs', 'Logs'], ['cache', 'Cache'], ['app', 'Application files (other categories excluded)'],
  ['provider', 'Provider files (shared with other apps)'], ['worktrees', 'Managed worktrees'],
] as const;

export function initialStorage(logCleanupSupported: boolean): StorageSnapshot {
  return {
    status: 'idle', startedAt: null, completedAt: null, stale: true,
    progress: { visitedEntries: 0, scannedBytes: 0, currentPath: null },
    categories: categoryDefinitions.map(([id, label]): StorageCategory => ({
      id, label, bytes: null, paths: [],
      cleanup: {
        supported: id === 'logs' && logCleanupSupported,
        reason: id === 'logs' && logCleanupSupported
          ? 'Only managed log files older than this backend launch and today; current logs are preserved.'
          : id === 'cache' ? 'Live desktop caches may be in use. No safely disposable inactive cache is configured.'
            : 'This category is not disposable through resource cleanup.',
      },
    })),
    volumes: [], errors: [],
  };
}

export async function assertRealPath(fs: ResourceFileSystem, path: string): Promise<void> {
  if (!isAbsolute(path) || canonicalPath(await fs.realPath(path)) !== canonicalPath(path)) {
    throw new Error(`Symlink, junction, or non-absolute path refused: ${path}`);
  }
}

export interface StorageScanDeps {
  fs: ResourceFileSystem;
  now(): number;
  roots(signal: AbortSignal, reportError: (message: string) => void): Promise<StorageRoot[]>;
  forbiddenRoots?: string[];
  excludedRoots?: string[];
  config: Pick<ResourcesConfig, 'maxScanEntries' | 'scanTimeoutMs'>;
}

/** Resumable per-root cursors rotate fairly; budgets yield, never discard progress. */
export async function scanStorage(
  deps: StorageScanDeps, state: StorageSnapshot, signal: AbortSignal,
): Promise<void> {
  const check = (): void => {
    if (signal.aborted) throw new Error(signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
      ? 'Storage inventory deadline exceeded; paths are incomplete.' : 'Storage scan cancelled.');
  };
  const inventorySignal = AbortSignal.any([signal, AbortSignal.timeout(deps.config.scanTimeoutMs)]);
  const roots = await deps.roots(inventorySignal, (message) => {
    state.errors.push(inventorySignal.aborted && !signal.aborted
      ? `Storage inventory deadline exceeded (${deps.config.scanTimeoutMs}ms): ${message}` : message);
  });
  check();
  const seenPaths = new Set<string>();
  const seenFiles = new Set<string>();
  const seenVolumes = new Set<string>();
  for (const category of state.categories) {
    category.paths = roots.filter((r) => r.category === category.id).map((r) => ({
      path: r.path, bytes: null, measuredAt: null, status: 'pending' as const, errors: [],
    }));
  }
  const allPaths = new Set([...roots.map((r) => canonicalPath(r.path)), ...(deps.excludedRoots ?? []).map(canonicalPath)]);
  const cursors: AsyncGenerator<void>[] = [];
  const updateTotals = (): void => {
    for (const category of state.categories) {
      const measured = category.paths.filter((p) => p.bytes !== null);
      category.bytes = measured.length ? measured.reduce((sum, p) => sum + p.bytes!, 0) : null;
    }
  };
  for (const category of state.categories) {
    for (const item of category.paths) {
      const key = canonicalPath(item.path);
      if (seenPaths.has(key)) {
        item.status = 'excluded';
        continue;
      }
      seenPaths.add(key);
      if (cursors.length >= 256) {
        item.status = 'unavailable';
        item.errors.push('Storage root limit (256) exceeded; narrow the configured inventory.');
        continue;
      }
      const scanRoot = async function* (): AsyncGenerator<void> {
        item.status = 'scanning';
        let bytes = 0;
        let measured = false;
        try {
          check();
          if (key === canonicalPath(parse(item.path).root) ||
            deps.forbiddenRoots?.some((path) => canonicalPath(path) === key)) {
            throw new Error('Broad profile or volume root refused; configure a scoped application directory.');
          }
          await assertRealPath(deps.fs, item.path);
          const rootStat = await deps.fs.stat(item.path);
          const volumeKey = rootStat.identity.split(':')[0]!;
          if (!seenVolumes.has(volumeKey)) {
            seenVolumes.add(volumeKey);
            try {
              state.volumes.push({ path: item.path, ...await deps.fs.volume(item.path), measuredAt: deps.now(), error: null });
            } catch (error) {
              state.volumes.push({ path: item.path, totalBytes: null, freeBytes: null, availableBytes: null, measuredAt: deps.now(), error: errorText(error) });
            }
          }
          yield;
          const visit = async function* (path: string, depth: number): AsyncGenerator<void> {
            check();
            if (depth > 128) throw new Error('Directory depth limit reached.');
            state.progress.visitedEntries++;
            state.progress.currentPath = path;
            yield;
            if (path !== item.path && allPaths.has(canonicalPath(path))) return;
            const stat = await deps.fs.stat(path);
            if (stat.kind === 'link') {
              item.excludedPaths ??= [];
              if (item.excludedPaths.length < 20) item.excludedPaths.push(path);
              return;
            }
            if (stat.kind === 'file') {
              // Ordinary files need no retained identity; only hardlinks can
              // alias another disjoint root. Bound this exceptional index.
              if (stat.linkCount > 1) {
                if (seenFiles.has(stat.identity)) return;
                if (seenFiles.size >= deps.config.maxScanEntries) throw new Error('Hardlink identity budget exceeded; size is incomplete.');
                seenFiles.add(stat.identity);
              }
              bytes += stat.size;
              state.progress.scannedBytes += stat.size;
              item.bytes = bytes;
            } else if (stat.kind === 'directory') {
              await assertRealPath(deps.fs, path);
              yield;
              for await (const name of deps.fs.entries(path)) {
                try {
                  yield* visit(resolve(path, name), depth + 1);
                } catch (error) {
                  check();
                  if (item.errors.length < 20) item.errors.push(errorText(error));
                }
              }
            }
            yield;
          };
          yield* visit(item.path, 0);
          measured = true;
          item.status = item.errors.length ? 'partial' : 'ready';
        } catch (error) {
          if (signal.aborted) throw error;
          item.errors.push(errorText(error));
          item.status = bytes > 0 ? 'partial' : 'unavailable';
        }
        item.bytes = measured || bytes > 0 ? bytes : null;
        item.measuredAt = deps.now();
      };
      cursors.push(scanRoot());
    }
  }
  // One root receives at most 64 entries/25ms before another gets a turn.
  // Awaiting each cursor retains a bounded number of open directory handles.
  try {
    while (cursors.length) {
      const cursor = cursors.shift()!;
      let done = false;
      const sliceStart = deps.now();
      try {
        for (let n = 0; n < Math.min(64, deps.config.maxScanEntries); n++) {
          check();
          done = (await cursor.next()).done === true;
          if (done || deps.now() - sliceStart >= Math.min(25, deps.config.scanTimeoutMs)) break;
        }
      } catch (error) {
        await cursor.return(undefined);
        throw error;
      }
      if (!done) cursors.push(cursor);
      updateTotals();
      // Explicitly yield even for hot filesystem caches and in-memory adapters.
      await new Promise<void>((resolveYield) => setImmediate(resolveYield));
    }
  } finally {
    for (const cursor of cursors) await cursor.return(undefined);
    for (const category of state.categories) for (const item of category.paths) {
      if (item.status === 'scanning' || item.status === 'pending') {
        item.status = item.bytes === null ? 'unavailable' : 'partial';
        item.errors.push('Storage scan cancelled before this path completed.');
        item.measuredAt = deps.now();
      }
    }
    updateTotals();
  }
  state.status = state.errors.length > 0 || state.categories.some((c) => c.paths.some((p) => p.status === 'partial' || p.status === 'unavailable'))
    || state.volumes.some((v) => v.error !== null) ? 'partial' : 'ready';
}
