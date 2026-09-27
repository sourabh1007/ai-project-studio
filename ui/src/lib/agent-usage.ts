import type { MetaOperationSummary } from '../features/meta-operations/meta-operation-types.js';

export interface AgentUsage {
  aic: number | null;
  operations: number;
  unknownOperations: number;
  running: boolean;
}

/** Session snapshots and operation snapshots are alternative sources, not additive. */
export function aggregateAgentUsage(
  operations: readonly MetaOperationSummary[],
  usageLabel: string,
  perspectiveId?: string,
): AgentUsage {
  const unique = new Map(operations.map((operation) => [operation.operationId, operation]));
  let nanoAiu = 0;
  let known = 0;
  let unknownOperations = 0;
  let running = false;
  const label = perspectiveId ? `${usageLabel} · ${perspectiveId}` : usageLabel;
  for (const operation of unique.values()) {
    if (operation.label !== label && (perspectiveId || !operation.label?.startsWith(`${label} · `))) continue;
    if (operation.outcome === 'not-dispatched' && operation.state !== 'pending') continue;
    running ||= operation.state === 'running' || operation.state === 'pending';
    const nano = operation.usage?.nanoAiu;
    if (nano == null || !Number.isFinite(nano) || nano < 0) {
      unknownOperations += 1;
    } else {
      nanoAiu += nano;
      known += 1;
    }

  }
  return {
    aic: known ? nanoAiu / 1_000_000_000 : null,
    operations: known + unknownOperations, unknownOperations, running,
  };
}

/** Refresh per-window costs only through persisted session identities, never titles. */
export function refreshAgentCredits<T extends { credits: number | null; sessionIds?: string[] }>(
  agents: readonly T[], operations: readonly MetaOperationSummary[],
): T[] {
  const unique = [...new Map(operations.map((operation) => [operation.operationId, operation])).values()];
  return agents.map((agent) => {
    if (!agent.sessionIds?.length) return agent;
    const ids = new Set(agent.sessionIds);
    const matches = unique.filter((operation) => operation.sessionIds.some((id) => ids.has(id)));
    const known = matches.map((operation) => operation.usage?.nanoAiu)
      .filter((value): value is number => value != null && Number.isFinite(value) && value >= 0);
    return {
      ...agent,
      credits: known.length > 0 && known.length === matches.length
        && [...ids].every((id) => matches.some((operation) => operation.sessionIds.includes(id)))
        ? known.reduce((sum, value) => sum + value, 0) / 1e9 : null,
    };
  });
}
