import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { ExecutionTimeline, InsightMatrix, useInsightVisibility } from '../monitoring/insights.js';
import type { MetaOperationPage, MetaOperationSummary, MetaOperationsQuery } from './meta-operation-types.js';
import { sharedRead } from '../monitoring/shared-read.js';

export function OperationInsights({ scope, signal = 0 }: { scope: Omit<MetaOperationsQuery, 'after' | 'limit'>; signal?: string | number }) {
  const api = useApi();
  const visibility = useInsightVisibility();
  const [window, setWindow] = useState({ from: '', to: '' });
  const bounded = Boolean(window.from || window.to);
  const duration = Date.parse(window.to) - Date.parse(window.from);
  const valid = !bounded || Number.isFinite(duration) && duration > 0 && duration <= 366 * 86400000;
  const key = JSON.stringify({ ...scope, ...(bounded && valid ? {
    from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString(),
  } : {}), window });
  const [page, setPage] = useState<MetaOperationPage | null>(null);
  const [navigation, setNavigation] = useState<{ key: string; after: string | null }>({ key: '', after: null });
  const cursor = navigation.key === key ? navigation.after : null;
  const [loadedKey, setLoadedKey] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<MetaOperationSummary | null>(null);
  const [view, setView] = useState('timeline');
  const [refresh, setRefresh] = useState(0);
  const [outcome, setOutcome] = useState<{ key: string; date: string; state: string } | null>(null);
  useEffect(() => { setSelected(null); }, [key, cursor]);
  useEffect(() => {
    if (!visibility.visible) return;
    let active = true;
    setError('');
    if (!valid) return;
    const { window: _window, ...query } = JSON.parse(key) as MetaOperationsQuery & { window: typeof window };
    void sharedRead(api, JSON.stringify(['operations', key, cursor, signal, refresh, visibility.revision]), () =>
      api.listMetaOperations({ ...query, after: cursor, limit: 100 }))
      .then((result) => { if (active) { setPage(result); setLoadedKey(key); } })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load operations'); });
    return () => { active = false; };
  }, [api, key, cursor, signal, refresh, valid, visibility.visible, visibility.revision]);
  const data = loadedKey === key ? page : null;
  const rows = data?.items ?? [];
  const pageKey = JSON.stringify([key, cursor]);
  const date = (row: MetaOperationSummary) => Number.isFinite(Date.parse(row.createdAt)) ? row.createdAt.slice(0, 10) : 'Unknown event time';
  const filtered = outcome?.key === pageKey ? rows.filter((row) => row.state === outcome.state && date(row) === outcome.date) : rows;
  const states = ['completed', 'failed', 'interrupted', 'running', 'pending'] as const;
  const dates = [...new Set(rows.map(date))].sort();
  const cohorts = new Map<string, MetaOperationSummary[]>();
  for (const row of rows) {
    const cohort = JSON.stringify([row.featureId, row.purpose, row.label, row.providerId, row.transport,
      row.resolvedModel ?? 'unresolved', row.state, row.outcome, row.correlation?.contextFingerprint ?? 'context-not-recorded']);
    const values = cohorts.get(cohort) ?? [];
    values.push(row); cohorts.set(cohort, values);
  }
  const milliseconds = (row: MetaOperationSummary) => {
    if (!row.startedAt || !row.finishedAt) return null;
    const duration = Date.parse(row.finishedAt) - Date.parse(row.startedAt);
    return Number.isFinite(duration) && duration >= 0 ? duration : null;
  };
  const percentile = (values: number[], quantile: number) => values.length
    ? [...values].sort((a, b) => a - b)[Math.ceil(quantile * values.length) - 1] : null;
  return <section aria-label="Operation insights">
    <p className="field-hint">A bounded page of at most 100 durable operations, not a population-wide success rate. Outcomes describe execution, not correctness.
      Result/prompt text is not loaded. Native internal retries without separate operation records are not reconstructed.</p>
    <label>Operation insight <select className="input" value={view} onChange={(event) => { setOutcome(null); setView(event.target.value); }}>
      <option value="timeline">Timing and outcomes</option><option value="outcomes">Recorded outcomes by day</option><option value="models">Model/route cohorts</option>
    </select></label>
    <button type="button" className="rb-linkish" onClick={() => setRefresh((value) => value + 1)}>Refresh operations</button>
    {!(scope.from && scope.to) && <div className="monitor-controls"><label>From (UTC, optional)<input className="input" type="date" value={window.from}
      onChange={(event) => setWindow({ ...window, from: event.target.value })} /></label>
      <label>To (UTC, exclusive)<input className="input" type="date" value={window.to}
        onChange={(event) => setWindow({ ...window, to: event.target.value })} /></label></div>}
    {!valid && <p role="alert">Choose both UTC dates, in a window of 1-366 days.</p>}
    {error && <p role="status">{data && 'Showing previous snapshot. '}{error}</p>}
    {!data && !error && valid && <p role="status">Loading operations...</p>}
    {view === 'timeline' && outcome?.key === pageKey && <p>Timeline filtered to {outcome.date} / {outcome.state} ({filtered.length} operations).
      <button type="button" className="rb-linkish" onClick={() => setOutcome(null)}>Clear outcome filter</button></p>}
    {view === 'timeline' ? <ExecutionTimeline items={filtered.map((row) => ({
      id: row.operationId, label: row.label ?? row.purpose ?? row.operationId, status: row.state,
      start: row.startedAt ? Date.parse(row.startedAt) : null, end: row.finishedAt ? Date.parse(row.finishedAt) : null,
      select: () => setSelected(row),
    }))} /> : view === 'outcomes' ? <InsightMatrix title="Recorded outcomes by UTC day" columns={['Completed', 'Failed', 'Interrupted', 'Running', 'Pending']}
      explanation="Operation creation day and recorded lifecycle state in this bounded page, not a population-wide failure rate or proof of correctness. Zero means no matching rows on this page."
      rows={dates.map((day) => ({ id: day, label: day, cells: states.map((state) => ({
        value: rows.filter((row) => date(row) === day && row.state === state).length,
        select: () => { setOutcome({ key: pageKey, date: day, state }); setView('timeline'); },
      })) }))} /> : <InsightMatrix title="Model and route observations" intensity={false} columns={['Samples', 'Timed', 'Median seconds', 'p95 seconds', 'Known AIC', 'Unknown billing']}
      explanation="Cohorts separate feature, purpose, label, provider, route, resolved model and captured context. Missing context is not a matched experiment. Small cohorts do not support p95. Faster is not better quality."
      rows={[...cohorts.entries()].map(([id, entries]) => {
        const times = entries.map(milliseconds).filter((value): value is number => value !== null);
        const billed = entries.filter((entry) => entry.usage?.nanoAiu != null);
        const sorted = [...times].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        const median = sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null;
        const p95 = times.length >= 20 ? percentile(times, 0.95) : null;
        return { id, label: `${entries[0].resolvedModel ?? 'Unresolved model'} · ${entries[0].providerId ?? 'Unknown provider'} · ${entries[0].transport} · ${entries[0].state}/${entries[0].outcome} · ${entries[0].label ?? entries[0].purpose ?? 'Unlabelled'} · ${entries[0].correlation?.contextFingerprint ?? 'Context not recorded'}`,
          cells: [{ value: entries.length }, { value: times.length }, { value: median == null ? null : median / 1000 },
            { value: p95 == null ? null : p95 / 1000 }, { value: billed.length ? billed.reduce((sum, entry) => sum + entry.usage!.nanoAiu!, 0) / 1e9 : null },
            { value: entries.length - billed.length }] };
      })} />}
    {data?.nextCursor && <button type="button" onClick={() => { setNavigation({ key, after: data.nextCursor }); setPage(null); }}>Next operation page</button>}
    {cursor && <button type="button" onClick={() => { setNavigation({ key, after: null }); setPage(null); }}>First operation page</button>}
    {selected && loadedKey === key && <div role="status"><h4>{selected.label ?? selected.operationId}</h4>
      <p>Operation {selected.operationId} · {selected.state} · {selected.outcome} · {selected.providerId ?? 'Unknown provider'} / {selected.resolvedModel ?? 'Unresolved model'}.
        Usage: {selected.usageState}. Physical termination is not implied by callback settlement.</p>
      <p>Created: {selected.createdAt} · start: {selected.startedAt ?? 'not recorded'} · finish: {selected.finishedAt ?? 'not recorded'}.</p>
    </div>}
  </section>;
}
