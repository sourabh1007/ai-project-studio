import type { ConnectionState } from './connection-status.js';
import type { ResourceSnapshot } from './types.js';

export interface ResourceStatusView {
  state: 'normal' | 'pressure' | 'unknown';
  label: string;
  detail: string;
}

const REASONS = {
  'high-cpu': 'high system CPU',
  'low-memory': 'low free system memory',
  'event-loop-lag': 'backend event-loop delay',
};

export function resourceStatus(
  snapshot: ResourceSnapshot | undefined,
  connection: ConnectionState,
  probeFailed: boolean,
  now: number,
): ResourceStatusView {
  if (connection !== 'online' || probeFailed) {
    return {
      state: 'unknown',
      label: connection === 'offline' ? 'Resources unknown' : 'Backend unresponsive',
      detail: 'Current resource measurements are unavailable. A failed request does not establish CPU or memory pressure.',
    };
  }
  if (!snapshot || snapshot.status === 'unknown' || snapshot.measuredAt === null
    || now < snapshot.measuredAt || now - snapshot.measuredAt >= snapshot.staleAfterMs) {
    return {
      state: 'unknown', label: 'Resources unknown',
      detail: 'Waiting for fresh system CPU, free memory, and backend event-loop measurements.',
    };
  }
  const detail = [
    `System CPU: ${snapshot.cpuPercent!.toFixed(0)}%.`,
    `Free memory: ${(snapshot.freeMemoryBytes! / 1024 ** 3).toFixed(1)} / ${(snapshot.totalMemoryBytes! / 1024 ** 3).toFixed(1)} GiB.`,
    `Peak backend event-loop delay: ${snapshot.eventLoopDelayMs!.toFixed(0)} ms.`,
    ...(snapshot.backgroundWork ? [
      `Background CPU tasks: ${snapshot.backgroundWork.active}/${snapshot.backgroundWork.maxWorkers} active, ${snapshot.backgroundWork.queued}/${snapshot.backgroundWork.maxQueued} queued. Queueing alone does not indicate resource pressure.`,
    ] : []),
    snapshot.status === 'pressure'
      ? `Measured pressure: ${snapshot.reasons.map((reason) => REASONS[reason]).join(', ')}. Work may be delayed. Reduce concurrent work or wait; retry failed reads after recovery.`
      : 'No resource pressure measured in the last sampling window.',
  ].join(' ');
  return {
    state: snapshot.status,
    label: snapshot.status === 'pressure' ? 'Resource pressure' : 'Resources normal',
    detail,
  };
}
