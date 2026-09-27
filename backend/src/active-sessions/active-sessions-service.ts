import type { MetaPoolsStatus } from '../meta/pooled-meta-runner.js';
import type { ActiveSessionDebug, ActiveSessionEntry, ActiveSessionRecord, ActiveSessionsService } from './active-sessions-contract.js';
import type { ActiveSessionsConfig } from './config.js';
import { redactDebugText } from './debug-redaction.js';
import type { MetaDebugTracker } from './meta-debug-tracker.js';

export interface ActiveSessionsDeps {
  config: ActiveSessionsConfig;
  now(): number;
  sessions(): ActiveSessionRecord[];
  pools(): MetaPoolsStatus;
  tracker: MetaDebugTracker;
  context(featureId: string): { featureName: string | null; projectName: string | null };
}

export function createActiveSessionsService(deps: ActiveSessionsDeps): ActiveSessionsService {
  const lastWarmOperation = new Map<string, string>();
  const safe = (value: string | null) => value === null ? null : redactDebugText(value).slice(0, 240);
  const context = (featureId: string | null) => {
    const names = featureId ? deps.context(featureId) : { featureName: null, projectName: null };
    return { featureName: safe(names.featureName), projectName: safe(names.projectName) };
  };
  function read() {
    const pools = deps.pools();
    const warm = pools.pool?.sessions ?? [];
    const entries: ActiveSessionEntry[] = [];
    const pooledSessions = new Set<string>();
    for (const session of warm) {
      const operationId = session.live?.operationId ?? null;
      const operation = operationId ? deps.tracker.get(operationId) : undefined;
      if (operationId) {
        lastWarmOperation.set(session.id, operationId);
        if (lastWarmOperation.size > deps.config.maxOperations) {
          lastWarmOperation.delete(lastWarmOperation.keys().next().value as string);
        }
      }
      for (const id of operation?.sessionIds ?? []) pooledSessions.add(id);
      const featureId = operation?.featureId ?? null;
      entries.push({
        id: `warm:${session.id}`, sessionId: null, kind: 'meta', state: session.retiring ? 'stopping' : session.state,
        transport: 'warm-acp', label: safe(session.live?.label ?? operation?.label ?? null) ?? `IDE warm session ${session.id}`,
        purpose: safe(session.live?.purpose ?? null),
        featureId, ...context(featureId), operationId,
        provider: operation?.providerId ?? null, model: operation?.requestedModel ?? pools.model ?? null,
      });
    }
    for (const session of deps.sessions()) {
      if (session.status !== 'running' || pooledSessions.has(session.id)) continue;
      const operation = deps.tracker.bySession(session.id);
      // A persisted bookkeeping record for a warm lease is not another process.
      if (operation?.transport === 'warm-acp') continue;
      const meta = session.kind === 'meta' || session.scope === 'internal';
      entries.push({
        id: `session:${session.id}`, sessionId: session.id, kind: meta ? 'meta' : 'session',
        state: meta ? 'busy' : 'running', transport: 'session',
        label: safe(operation?.label ?? session.name) ?? (meta ? 'IDE metasession' : `Session ${session.seq ? `#${session.seq}` : session.id}`),
        purpose: safe(operation?.purpose ?? null), featureId: session.featureId, ...context(session.featureId),
        operationId: operation?.operationId ?? null, provider: session.provider, model: session.requestedModel,
      });
    }
    return { pools, entries };
  }
  return {
    snapshot() {
      return { sampledAt: deps.now(), pollMs: deps.config.pollMs, entries: read().entries };
    },
    debug(id): ActiveSessionDebug {
      const { entries, pools } = read();
      const entry = entries.find((item) => item.id === id) ?? null;
      const warmId = id.startsWith('warm:') ? id.slice(5) : null;
      const warm = pools.pool?.sessions.find((item) => item.id === warmId);
      const operationId = entry?.operationId ?? (warmId ? lastWarmOperation.get(warmId) : undefined);
      const operation = operationId ? deps.tracker.get(operationId)
        : id.startsWith('session:') ? deps.tracker.bySession(id.slice(8)) : undefined;
      const output = redactDebugText(warm?.live?.response ?? operation?.output ?? '');
      return {
        sampledAt: deps.now(), entry, state: operation?.state ?? entry?.state ?? 'unavailable',
        activity: operation?.activity.slice() ?? [], output: output.slice(-deps.config.maxTextCharacters),
        error: operation?.error ?? null,
        truncated: (operation?.truncated ?? false) || output.length > deps.config.maxTextCharacters,
      };
    },
  };
}
