import { useEffect, useRef, useState } from 'react';
import { useApi } from '../app/api-context.js';
import { resolveApiBase } from '../lib/api-base.js';
import { aggregateAgentUsage } from '../lib/agent-usage.js';
import type { MetaOperationSummary } from '../features/meta-operations/meta-operation-types.js';
import { liveSignal, type LiveState } from '../lib/stream.js';

/** Refresh from persisted snapshots on capture, reconnect and late provider writes. */
export function useAgentUsage(
  featureId: string | readonly string[],
  usageLabel: string,
  perspectiveId?: string,
  live?: LiveState,
) {
  const api = useApi();
  const featureIds = [...new Set(typeof featureId === 'string' ? [featureId] : featureId)].sort();
  const key = JSON.stringify(featureIds);
  const sharedStream = live !== undefined;
  const revision = live === undefined ? 0 : liveSignal(live);
  const reload = useRef<() => void>(() => {});
  const [state, setState] = useState<{
    key: string; operations: MetaOperationSummary[]; error: boolean; loading: boolean;
  }>({ key, operations: [], error: false, loading: true });
  useEffect(() => {
    const ids = JSON.parse(key) as string[];
    let disposed = false;
    let loading = false;
    let requested = false;
    const load = async () => {
      if (loading) { requested = true; return; }
      loading = true;
      try {
        const operations: MetaOperationSummary[] = [];
        for (const id of ids) {
          let after: string | null = null;
          const cursors = new Set<string>();
          do {
            const page = await api.listMetaOperations({ featureId: id, after, limit: 100 });
            if (disposed) return;
            operations.push(...page.items);
            after = page.nextCursor;
            if (after && cursors.has(after)) throw new Error('Repeated usage cursor');
            if (after) cursors.add(after);
          } while (after !== null);
        }
        setState({ key, operations, error: false, loading: false });
      } catch {
        if (!disposed) setState((current) => current.key === key
          ? { ...current, error: true, loading: false }
          : { key, operations: [], error: true, loading: false });
      } finally {
        loading = false;
        if (requested && !disposed) { requested = false; void load(); }
      }
    };
    void load();
    const base = resolveApiBase(window.__CW_API_BASE__, import.meta.env.VITE_API_BASE);
    const source = sharedStream ? null : new EventSource(`${base}/stream?output=0`);
    const refresh = () => { void load(); };
    reload.current = refresh;
    const updated = (raw: Event) => {
      try {
        const event = JSON.parse((raw as MessageEvent<string>).data) as { featureId?: string };
        if (event.featureId !== undefined && ids.includes(event.featureId)) refresh();
      } catch { /* Reconnect/poll repairs a malformed notification. */ }
    };
    source?.addEventListener('meta.usage.updated', updated);
    source?.addEventListener('open', refresh);
    const timer = setInterval(refresh, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
      reload.current = () => {};
      source?.removeEventListener('meta.usage.updated', updated);
      source?.removeEventListener('open', refresh);
      source?.close();
    };
  }, [api, key, sharedStream]);
  const previousRevision = useRef(revision);
  useEffect(() => {
    if (previousRevision.current !== revision) reload.current();
    previousRevision.current = revision;
  }, [revision]);
  const current = state.key === key ? state : { operations: [], loading: true, error: false };
  const byFeature = Object.fromEntries(featureIds.map((id) => [
    id, aggregateAgentUsage(current.operations.filter((operation) => operation.featureId === id), usageLabel, perspectiveId),
  ]));
  return {
    ...aggregateAgentUsage(current.operations, usageLabel, perspectiveId),
    byFeature,
    incompleteFeatures: featureIds.filter((id) => byFeature[id].aic === null).length,
    snapshots: current.operations,
    loading: current.loading, error: current.error,
  };
}
