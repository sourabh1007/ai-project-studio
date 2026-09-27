import type { AppResourceSnapshot, ResourcesSnapshot } from './resources-contract.js';

/** Wire projection never disguises partial/stale process totals as full app usage. */
export function resourceView(snapshot: ResourcesSnapshot): AppResourceSnapshot {
  const { app, storage } = snapshot;
  const unavailable = app.status === 'unavailable' || app.status === 'stale';
  const cpuComplete = !unavailable && app.status === 'ready' && app.processCount > 0;
  const memoryComplete = !unavailable && app.processCount > 0 && app.processes.every((p) => p.memoryBytes !== null);
  const categoryErrors = storage.categories.flatMap((category) => category.paths.flatMap((path) => path.errors));
  const storageErrors = [...storage.errors, ...categoryErrors];
  const categories = storage.categories.map((category) => {
    const errors = category.paths.flatMap((path) => path.errors);
    const incomplete = category.paths.some((path) => path.status !== 'ready' && path.status !== 'excluded');
    const paths = category.paths.filter((path) => path.status !== 'excluded').map((path) => path.path);
    return {
      id: category.id, kind: category.id, label: category.label,
      paths,
      bytes: incomplete ? null : category.bytes,
      cleanupSupported: category.cleanup.supported && paths.length > 0,
      cleanupReason: category.cleanup.supported && paths.length === 0
        ? 'Cleanup paths are not available yet; refresh storage first.' : category.cleanup.reason,
      error: errors.length ? errors.join('; ') : category.paths.length || storage.status === 'scanning'
        ? null : 'No scoped paths configured or inventory is unavailable.',
      pathDetails: category.paths,
    };
  });
  return {
    measuredAt: snapshot.sampledAt, staleAfterMs: app.staleAfterMs,
    processes: {
      status: unavailable ? app.measuredAt === null && app.errors[0] === 'Process sampling has not completed.'
        ? 'sampling' : 'unavailable' : cpuComplete ? 'ready' : 'sampling',
      sampledAt: app.measuredAt,
      error: app.status === 'stale' ? 'Process measurements are stale; waiting for a fresh sample.'
        : app.errors.length ? app.errors.join('; ') : null,
      rootPid: app.rootPid,
      cpuPercent: cpuComplete && app.cpuPercent !== null ? Math.min(100, app.cpuPercent) : null,
      memoryBytes: memoryComplete ? app.memoryBytes : null,
      items: app.processes.map((p) => ({
        pid: p.pid, parentPid: p.parentPid || null, name: p.name, role: p.role,
        startedAt: new Date(p.startedAt).toISOString(),
        cpuPercent: unavailable ? null : p.cpuPercent,
        memoryBytes: unavailable ? null : p.memoryBytes,
      })),
    },
    storage: {
      status: storage.status === 'scanning' ? 'scanning' : storage.status === 'idle' || storage.status === 'unavailable' || storage.status === 'partial'
        ? 'unavailable' : 'ready',
      scannedAt: storage.completedAt,
      error: storageErrors.length ? storageErrors.slice(0, 20).join('; ') : null,
      categories, volumes: storage.volumes,
      progress: storage.progress, stale: storage.stale,
    },
    cleanups: snapshot.cleanups,
  };
}
