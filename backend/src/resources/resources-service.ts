import type { ResourcesConfig } from './config.js';
import { parse, resolve } from 'node:path';
import type { ResourceSnapshot } from '../resource-pressure/resource-pressure.js';
import type {
  AppResources, ProcessSample, ResourceCleanup, ResourceFileSystem, ResourcesService, StorageRoot,
} from './resources-contract.js';
import { createProcessAttribution } from './process-attribution.js';
import { canonicalPath, errorText, initialStorage, scanStorage } from './storage-scanner.js';
import { cleanupFiles, supportsLogCleanup, type LogCleanupPolicy } from './safe-cleanup.js';

export interface ResourcesDeps {
  config: ResourcesConfig;
  now(): number;
  backendPid: number;
  host(): ResourceSnapshot;
  processes(signal: AbortSignal): Promise<ProcessSample>;
  roots(signal: AbortSignal, reportError: (message: string) => void): Promise<StorageRoot[]>;
  forbiddenRoots?: string[];
  fs: ResourceFileSystem;
  logs: LogCleanupPolicy;
}

/** HTTP reads cached state; sampling, scans and cleanup each have one bounded owner. */
export function createResourcesService(deps: ResourcesDeps): ResourcesService {
  const attribute = createProcessAttribution(deps.backendPid, deps.config.desktopPid, deps.config.staleAfterMs);
  let app: AppResources = {
    status: 'unavailable', measuredAt: null, staleAfterMs: deps.config.staleAfterMs,
    rootPid: null, cpuPercent: null, memoryBytes: null, processCount: 0,
    cpuMeasuredProcessCount: 0, cpuNormalization: 'percent-of-host-logical-cpus',
    memoryMetric: 'summed-working-set-rss-shared-pages-may-overlap',
    processes: [], errors: ['Process sampling has not completed.'],
  };
  let storage = initialStorage(supportsLogCleanup(deps.logs));
  let processRun: Promise<void> | undefined;
  let scanRun: Promise<void> | undefined;
  let cleanupRunning = false;
  let disposed = false;
  const cleanups: ResourceCleanup[] = [];
  let pendingCleanup: ResourceCleanup | undefined;
  let cleanupSequence = 0;
  const abort = new AbortController();
  const storageSnapshot = () => ({
    ...storage,
    stale: storage.completedAt === null || deps.now() - storage.completedAt >= deps.config.storageStaleAfterMs,
  });
  const refreshLogs = async (): Promise<string[]> => {
    const target = initialStorage(supportsLogCleanup(deps.logs));
    const logs = target.categories.find((category) => category.id === 'logs')!;
    logs.paths = [{ path: deps.logs.directory, bytes: null, measuredAt: null, status: 'pending', errors: [] }];
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(deps.config.scanTimeoutMs)]);
    try {
      await scanStorage({
        ...deps,
        roots: async () => [{ category: 'logs', path: deps.logs.directory }],
        excludedRoots: storage.categories.filter((category) => category.id !== 'logs')
          .flatMap((category) => category.paths.map((entry) => entry.path)),
      }, target, signal);
    } catch (error) {
      target.errors.push(`Could not refresh remaining log size: ${errorText(error)}`);
    }
    const errors = [...target.errors, ...logs.paths.flatMap((entry) => entry.errors)];
    if (errors.length) for (const entry of logs.paths) {
      entry.errors = [...new Set([...entry.errors, ...errors])];
      entry.status = entry.bytes === null ? 'unavailable' : 'partial';
    }
    storage.categories = storage.categories.map((category) => category.id === 'logs' ? logs : category);
    for (const volume of target.volumes) {
      const root = canonicalPath(parse(resolve(volume.path)).root);
      const previous = storage.volumes.findIndex((entry) => canonicalPath(parse(resolve(entry.path)).root) === root);
      if (previous < 0) storage.volumes.push(volume);
      else storage.volumes[previous] = volume;
    }
    storage.progress.scannedBytes = storage.categories.reduce((sum, category) => sum + (category.bytes ?? 0), 0);
    return errors;
  };
  const service: ResourcesService = {
    snapshot: () => ({
      sampledAt: deps.now(), host: deps.host(),
      app: {
        ...app,
        status: app.measuredAt !== null && deps.now() - app.measuredAt >= deps.config.staleAfterMs ? 'stale' : app.status,
      },
      storage: storageSnapshot(),
      cleanups: cleanups.map((job) => ({ ...job })),
    }),
    sample() {
      if (disposed) return Promise.resolve();
      if (processRun) return processRun;
      processRun = (async () => {
        try {
          const result = await deps.processes(abort.signal);
          if (!disposed) app = attribute(result);
        } catch (error) {
          app = { ...app, status: 'unavailable', errors: [errorText(error)] };
        } finally { processRun = undefined; }
      })();
      return processRun;
    },
    refreshStorage() {
      if (disposed || scanRun || cleanupRunning || pendingCleanup) return { accepted: false, storage: storageSnapshot() };
      storage = initialStorage(supportsLogCleanup(deps.logs));
      storage.status = 'scanning';
      storage.startedAt = deps.now();
      scanRun = Promise.resolve().then(async () => {
        try {
          await scanStorage(deps, storage, abort.signal);
        } catch (error) {
          storage.status = 'unavailable';
          storage.errors.push(errorText(error));
        } finally {
          storage.completedAt = deps.now();
          storage.progress.currentPath = null;
          scanRun = undefined;
        }
      });
      return { accepted: true, storage: storageSnapshot() };
    },
    async cleanup(category) {
      if (disposed || cleanupRunning || scanRun) return {
        category, status: 'busy', deletedFiles: 0, freedBytes: 0, skippedFiles: 0,
        errors: ['Storage work is already running or the service has stopped.'], completedAt: deps.now(),
      };
      cleanupRunning = true;
      try {
        if (category === 'logs' && supportsLogCleanup(deps.logs)) await refreshLogs();
        const result = await cleanupFiles({
          fs: deps.fs, now: deps.now, policy: deps.logs,
          maxEntries: deps.config.maxScanEntries, timeoutMs: deps.config.scanTimeoutMs,
          onDeleted: (bytes) => {
            const logs = storage.categories.find((entry) => entry.id === 'logs')!;
            const entry = logs.paths[0]!;
            if (entry.bytes !== null) {
              entry.bytes = Math.max(0, entry.bytes - bytes);
              entry.measuredAt = deps.now();
              logs.bytes = entry.bytes;
              storage.progress.scannedBytes = Math.max(0, storage.progress.scannedBytes - bytes);
            }
          },
          onProgress: (progress) => {
            if (pendingCleanup) {
              pendingCleanup.removedBytes = progress.freedBytes;
              pendingCleanup.removedFiles = progress.deletedFiles;
              pendingCleanup.skippedFiles = progress.skippedFiles;
            }
          },
        }, category, abort.signal);
        if (category === 'logs' && result.status !== 'unsupported') {
          const errors = await refreshLogs();
          if (errors.length) {
            result.errors.push(...errors);
            if (result.status === 'completed') result.status = 'partial';
          }
        }
        return result;
      } finally { cleanupRunning = false; }
    },
    requestCleanup(category) {
      if (pendingCleanup?.category === category) return { ...pendingCleanup };
      const job: ResourceCleanup = {
        id: `cleanup-${deps.now()}-${++cleanupSequence}`, category, status: 'queued',
        removedBytes: 0, removedFiles: 0, skippedFiles: 0, error: null,
      };
      cleanups.push(job);
      if (disposed || pendingCleanup || cleanupRunning) {
        job.status = 'failed';
        job.error = 'Cleanup is already running or the service has stopped.';
      } else if (category === 'cache' || !supportsLogCleanup(deps.logs)) {
        job.status = 'failed';
        job.error = initialStorage(supportsLogCleanup(deps.logs)).categories.find((c) => c.id === category)!.cleanup.reason;
      } else {
        pendingCleanup = job;
        const scan = scanRun;
        void Promise.resolve().then(async () => {
          if (scan) await scan;
          job.status = 'running';
          const result = await service.cleanup(category);
          job.removedBytes = result.freedBytes;
          job.removedFiles = result.deletedFiles;
          job.skippedFiles = result.skippedFiles;
          job.status = result.status === 'completed' ? 'completed' : 'failed';
          job.error = result.errors.length ? result.errors.join('; ') : null;
        }).catch((error) => {
          job.status = 'failed';
          job.error = errorText(error);
        }).finally(() => { pendingCleanup = undefined; });
      }
      if (cleanups.length > 10) cleanups.splice(cleanups.findIndex((entry) => entry !== pendingCleanup), 1);
      return { ...job };
    },
    dispose() { disposed = true; abort.abort(); },
  };
  return service;
}
