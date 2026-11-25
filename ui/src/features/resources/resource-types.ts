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
  kind: 'worktrees' | 'app' | 'provider' | 'cache' | 'logs';
  label: string;
  paths: string[];
  bytes: number | null;
  cleanupSupported: boolean;
  cleanupReason: string | null;
  error: string | null;
  pathDetails?: {
    path: string;
    bytes: number | null;
    measuredAt: number | null;
    status: 'ready' | 'scanning' | 'partial' | 'unavailable' | 'excluded';
    errors: string[];
  }[];
}

export interface ResourceCleanup {
  id: string;
  category: 'logs' | 'cache';
  status: 'queued' | 'running' | 'completed' | 'failed';
  removedBytes: number;
  removedFiles: number;
  skippedFiles: number;
  error: string | null;
}

export interface AppResourceSnapshot {
  history?: {
    startedAt: number; maxGapMs: number; error: string | null;
    samples: { at: number; hostCpu: number | null; freeMemory: number | null; appCpu: number | null; appMemory: number | null; eventLoopDelay: number | null }[];
    storage: { at: number; category: string; scope: string; bytes: number | null }[];
  };
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
    progress?: { visitedEntries: number; scannedBytes: number; currentPath: string | null };
    stale?: boolean;
    error: string | null;
    categories: ResourceStorageCategory[];
    volumes: {
      path: string;
      totalBytes: number | null;
      freeBytes: number | null;
      error: string | null;
    }[];
  };
  cleanups: ResourceCleanup[];
}
