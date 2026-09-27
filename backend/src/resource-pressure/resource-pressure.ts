import type { ResourcePressureConfig } from './config.js';

export interface ResourceReading {
  measuredAt: number;
  cpuPercent: number;
  freeMemoryBytes: number;
  totalMemoryBytes: number;
  eventLoopDelayMs: number;
}

export type PressureReason = 'high-cpu' | 'low-memory' | 'event-loop-lag';

export interface ResourceSnapshot {
  status: 'normal' | 'pressure' | 'unknown';
  reasons: PressureReason[];
  measuredAt: number | null;
  staleAfterMs: number;
  cpuPercent: number | null;
  freeMemoryBytes: number | null;
  totalMemoryBytes: number | null;
  eventLoopDelayMs: number | null;
  /** Admission counts are context, not evidence of CPU or memory pressure. */
  backgroundWork?: {
    active: number;
    queued: number;
    maxWorkers: number;
    maxQueued: number;
  };
}

export interface ResourceMonitor {
  snapshot(): ResourceSnapshot;
  dispose(): void;
}

/** CPU utilization over a sampling window, not lifetime utilization or load average. */
export function cpuUtilization(
  previous: { idle: number; total: number },
  current: { idle: number; total: number },
): number {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0 || idle < 0 || idle > total) return Number.NaN;
  return (1 - idle / total) * 100;
}

/** Never turn missing, invalid, or expired measurements into a pressure diagnosis. */
export function evaluateResources(
  reading: ResourceReading | undefined,
  now: number,
  config: ResourcePressureConfig,
): ResourceSnapshot {
  const unknown: ResourceSnapshot = {
    status: 'unknown', reasons: [], measuredAt: null,
    staleAfterMs: config.staleAfterMs,
    cpuPercent: null, freeMemoryBytes: null, totalMemoryBytes: null,
    eventLoopDelayMs: null,
  };
  if (!reading) return unknown;
  if (!Object.values(reading).every(Number.isFinite)
    || now < reading.measuredAt || now - reading.measuredAt >= config.staleAfterMs
    || reading.cpuPercent < 0 || reading.cpuPercent > 100
    || reading.totalMemoryBytes <= 0 || reading.freeMemoryBytes < 0
    || reading.freeMemoryBytes > reading.totalMemoryBytes || reading.eventLoopDelayMs < 0) {
    return unknown;
  }
  const reasons: PressureReason[] = [];
  if (reading.cpuPercent >= config.highCpuPercent) reasons.push('high-cpu');
  if (reading.freeMemoryBytes / reading.totalMemoryBytes * 100 <= config.lowFreeMemoryPercent) {
    reasons.push('low-memory');
  }
  if (reading.eventLoopDelayMs >= config.highEventLoopDelayMs) reasons.push('event-loop-lag');
  return {
    ...reading, staleAfterMs: config.staleAfterMs,
    status: reasons.length > 0 ? 'pressure' : 'normal', reasons,
  };
}
