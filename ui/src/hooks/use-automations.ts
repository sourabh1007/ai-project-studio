import { useEffect, useState } from 'react';
import { useApi } from '../app/api-context.js';
import type { LiveState } from '../lib/stream.js';
import type { Automation, Subagent } from '../lib/types.js';

export interface AutomationsLive {
  automations: Automation[];
  subagents: Subagent[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Live Automations state: seeds from the persisted `GET /automations` snapshot
 * on mount, then overlays live `automation.*` / `subagent.*` SSE events so the
 * page stays fresh as monitors tick. The persisted snapshot is authoritative on
 * (re)load; live events only add/update entries observed since connecting.
 */
export function useAutomations(live: LiveState): AutomationsLive {
  const api = useApi();
  const [snapshot, setSnapshot] = useState<{
    automations: Record<string, Automation>;
    subagents: Record<string, Subagent>;
  }>({ automations: {}, subagents: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .listAutomations()
      .then((result) => {
        if (cancelled) {
          return;
        }
        const automations: Record<string, Automation> = {};
        for (const automation of result.automations) {
          automations[automation.id] = automation;
        }
        const subagents: Record<string, Subagent> = {};
        for (const subagent of result.subagents) {
          subagents[subagent.id] = subagent;
        }
        setSnapshot({ automations, subagents });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, nonce]);

  // Merge the persisted snapshot with live events. Newest updatedAt wins so a
  // stale live event cannot mask a fresh reload after Pause/Cancel/Run now.
  const automations = mergeById(snapshot.automations, live.automations);
  const subagents = mergeById(snapshot.subagents, live.subagents);

  return {
    automations,
    subagents,
    loading,
    error,
    reload: () => setNonce((n) => n + 1),
  };
}

function mergeById<T>(
  snapshot: Record<string, T>,
  liveMap: Record<string, T>,
): T[] {
  const merged: Record<string, T> = { ...snapshot, ...liveMap };
  for (const [id, snapshotValue] of Object.entries(snapshot)) {
    const liveValue = liveMap[id];
    if (!liveValue) {
      continue;
    }
    if (updatedAt(snapshotValue) >= updatedAt(liveValue)) {
      merged[id] = snapshotValue;
    }
  }
  return Object.values(merged);
}

function updatedAt(value: unknown): string {
  return typeof value === 'object' &&
    value !== null &&
    'updatedAt' in value &&
    typeof value.updatedAt === 'string'
    ? value.updatedAt
    : '';
}
