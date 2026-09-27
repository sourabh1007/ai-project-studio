import type { ResourceSnapshot } from '../resource-pressure/resource-pressure.js';

export type ProcessRole = 'backend' | 'desktop-main' | 'renderer' | 'gpu' | 'utility' | 'cli' | 'child';
export interface ProcessReading {
  pid: number;
  parentPid: number;
  startedAt: number;
  name: string;
  role: ProcessRole;
  cpuTimeMs: number | null;
  memoryBytes: number | null;
}
export interface ProcessSample {
  measuredAt: number;
  logicalCpuCount: number;
  processes: ProcessReading[];
}
export interface AppProcess extends Omit<ProcessReading, 'cpuTimeMs'> {
  identity: string;
  cpuPercent: number | null;
}
export interface AppResources {
  status: 'ready' | 'partial' | 'unavailable' | 'stale';
  measuredAt: number | null;
  staleAfterMs: number;
  rootPid: number | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  processCount: number;
  cpuMeasuredProcessCount: number;
  cpuNormalization: 'percent-of-host-logical-cpus';
  memoryMetric: 'summed-working-set-rss-shared-pages-may-overlap';
  processes: AppProcess[];
  errors: string[];
}
export type StorageCategoryId = 'worktrees' | 'app' | 'provider' | 'cache' | 'logs';
export type CleanupCategory = 'cache' | 'logs';
export interface StorageRoot { category: StorageCategoryId; path: string }
export interface StoragePath {
  path: string;
  bytes: number | null;
  measuredAt: number | null;
  status: 'pending' | 'scanning' | 'ready' | 'partial' | 'unavailable' | 'excluded';
  errors: string[];
  /** Expected links excluded from logical file-byte accounting, not scan failures. */
  excludedPaths?: string[];
}
export interface StorageCategory {
  id: StorageCategoryId;
  label: string;
  bytes: number | null;
  paths: StoragePath[];
  cleanup: { supported: boolean; reason: string };
}
export interface StorageVolume {
  path: string;
  totalBytes: number | null;
  freeBytes: number | null;
  availableBytes: number | null;
  measuredAt: number;
  error: string | null;
}
export interface StorageSnapshot {
  status: 'idle' | 'scanning' | 'ready' | 'partial' | 'unavailable';
  startedAt: number | null;
  completedAt: number | null;
  stale: boolean;
  progress: { visitedEntries: number; scannedBytes: number; currentPath: string | null };
  categories: StorageCategory[];
  volumes: StorageVolume[];
  errors: string[];
}
export interface CleanupResult {
  category: CleanupCategory;
  status: 'completed' | 'partial' | 'unsupported' | 'busy' | 'failed';
  deletedFiles: number;
  /** Logical bytes removed; compression/sparse allocation can differ from volume free-space delta. */
  freedBytes: number;
  skippedFiles: number;
  errors: string[];
  completedAt: number;
}
export interface ResourcesSnapshot {
  sampledAt: number;
  host: ResourceSnapshot;
  app: AppResources;
  storage: StorageSnapshot;
  cleanups: ResourceCleanup[];
}
export interface ResourcesService {
  snapshot(): ResourcesSnapshot;
  sample(): Promise<void>;
  refreshStorage(): { accepted: boolean; storage: StorageSnapshot };
  cleanup(category: CleanupCategory): Promise<CleanupResult>;
  requestCleanup(category: CleanupCategory): ResourceCleanup;
  dispose(): void;
}

/** Wire contract mirrored by ui/src/features/resources/resource-types.ts. */
export interface ResourceProcess {
  pid: number;
  parentPid: number | null;
  name: string;
  role: string;
  startedAt: string | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
}
export interface ResourceStorageCategory {
  id: string;
  kind: StorageCategoryId;
  label: string;
  paths: string[];
  bytes: number | null;
  cleanupSupported: boolean;
  cleanupReason: string | null;
  error: string | null;
  /** Additional diagnostic detail; sizes here can be explicitly partial. */
  pathDetails?: StoragePath[];
}
export interface ResourceCleanup {
  id: string;
  category: CleanupCategory;
  status: 'queued' | 'running' | 'completed' | 'failed';
  removedBytes: number;
  removedFiles: number;
  skippedFiles: number;
  error: string | null;
}
export interface AppResourceSnapshot {
  measuredAt: number;
  staleAfterMs: number;
  processes: {
    status: 'ready' | 'sampling' | 'unavailable';
    sampledAt: number | null;
    error: string | null;
    rootPid: number | null;
    cpuPercent: number | null;
    memoryBytes: number | null;
    items: ResourceProcess[];
  };
  storage: {
    status: 'ready' | 'scanning' | 'unavailable';
    scannedAt: number | null;
    error: string | null;
    categories: ResourceStorageCategory[];
    volumes: {
      path: string;
      totalBytes: number | null;
      freeBytes: number | null;
      error: string | null;
    }[];
    progress?: StorageSnapshot['progress'];
    stale?: boolean;
  };
  cleanups: ResourceCleanup[];
}

export interface FileInfo {
  kind: 'file' | 'directory' | 'link' | 'other';
  size: number;
  identity: string;
  modifiedAt: number;
  linkCount: number;
}
/** Implementations never follow links; realPath validates every ancestor too. */
export interface ResourceFileSystem {
  realPath(path: string): Promise<string>;
  stat(path: string): Promise<FileInfo>;
  entries(path: string): AsyncIterable<string>;
  unlink(path: string): Promise<void>;
  volume(path: string): Promise<Omit<StorageVolume, 'path' | 'measuredAt' | 'error'>>;
}
