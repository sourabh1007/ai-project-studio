import type { ResourcesConfig } from './config.js';
import type { ResourceHistory, ResourceHistoryStore, ResourcesSnapshot } from './resources-contract.js';

export function createResourceHistory(config: ResourcesConfig, now: () => number, store?: ResourceHistoryStore) {
  let state: ResourceHistory = { startedAt: now(), maxGapMs: config.sampleIntervalMs * 3, error: null, samples: [], storage: [] };
  try {
    const saved = store?.load();
    if (saved) state = { ...saved, maxGapMs: state.maxGapMs, error: null };
  } catch { state.error = 'Resource history could not be restored.'; }
  const trim = () => {
    const time = now();
    state.samples = state.samples.filter((point) => point.at <= time && point.at >= time - config.historyMaxAgeMs)
      .slice(-config.historyMaxPoints);
    state.storage = state.storage.filter((point) => point.at <= time)
      .slice(-config.storageHistoryMaxScans * 5);
  };
  const persist = () => {
    trim();
    try { store?.save(state); state.error = null; }
    catch { state.error = 'Resource history persistence is unavailable; live samples remain available.'; }
  };
  return {
    sample(snapshot: ResourcesSnapshot) {
      const { host, app } = snapshot;
      const at = now();
      const fresh = host.measuredAt !== null && host.measuredAt <= at && at - host.measuredAt < host.staleAfterMs;
      const ready = app.status === 'ready';
      state.samples = state.samples.filter((point) => point.at !== at);
      state.samples.push({
        at, hostCpu: fresh ? host.cpuPercent : null, freeMemory: fresh ? host.freeMemoryBytes : null,
        eventLoopDelay: fresh ? host.eventLoopDelayMs : null,
        appCpu: ready ? app.cpuPercent : null, appMemory: ready ? app.memoryBytes : null,
      });
      persist();
    },
    storage(snapshot: ResourcesSnapshot) {
      const at = snapshot.storage.completedAt!;
      for (const category of snapshot.storage.categories) {
        const scope = JSON.stringify(category.paths.map((path) => path.path).sort());
        state.storage = state.storage.filter((point) => point.at !== at || point.category !== category.id);
        state.storage.push({ at, category: category.id, scope,
          bytes: category.paths.length > 0 && category.paths.every((path) => path.status === 'ready' || path.status === 'excluded')
            ? category.bytes : null });
      }
      persist();
    },
    snapshot(): ResourceHistory {
      trim();
      return { ...state, samples: state.samples.map((point) => ({ ...point })), storage: state.storage.map((point) => ({ ...point })) };
    },
  };
}
