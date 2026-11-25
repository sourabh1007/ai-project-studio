import type { MetaConfig } from './config.js';
import type { MetaPoolsStatus } from './pooled-meta-runner.js';

export interface CapacityPoint {
  at: number; provider: string; model: string | null;
  busy: number | null; idle: number | null; warming: number | null;
  processes: number | null; queued: number | null;
}
export interface CapacityHistoryStore { load(): CapacityPoint[]; save(points: CapacityPoint[]): void }
export function createCapacityHistory(deps: {
  config: Pick<MetaConfig, 'monitoringHistoryPoints' | 'monitoringHistoryMs'>;
  now(): number; store: CapacityHistoryStore;
}) {
  let samples: CapacityPoint[] = [];
  let error: string | null = null;
  try { samples = deps.store.load(); } catch { error = 'Capacity history could not be restored.'; }
  const trim = () => {
    const now = deps.now();
    samples = samples.filter((point) => point.at <= now && point.at >= now - deps.config.monitoringHistoryMs)
      .slice(-deps.config.monitoringHistoryPoints);
  };
  return {
    sample(status: MetaPoolsStatus, provider: string) {
      const at = deps.now();
      samples = samples.filter((point) => point.at !== at);
      samples.push({ at, provider, model: status.model ?? null, busy: status.pool?.busy ?? null,
        idle: status.pool?.idle ?? null, warming: status.pool?.sessions.filter((session) => session.state === 'warming').length ?? null,
        processes: status.processAdmission?.processes ?? null, queued: status.processAdmission?.queued ?? null });
      trim();
      try { deps.store.save(samples); error = null; } catch { error = 'Capacity history is live-only because persistence failed.'; }
    },
    snapshot() { trim(); return { samples: samples.map((point) => ({ ...point })), error }; },
  };
}
