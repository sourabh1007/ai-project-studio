import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import type { UsageRollup, StoredUsage } from '../../lib/types.js';
import { formatAic } from '../../lib/format.js';
import { HistoryChart, InsightMatrix, Insights, useInsightVisibility, type MatrixRow } from '../monitoring/insights.js';
import { OperationInsights } from '../meta-operations/operation-insights.js';
import { sharedRead } from '../monitoring/shared-read.js';
import type { UsageWindow } from '../../lib/usage-window.js';

const day = (time: number) => new Date(time).toISOString().slice(0, 10);
export function RecordedUsageInsights({ events }: { events: StoredUsage[] }) {
  const [metric, setMetric] = useState('aic');
  const days = new Map<string, number | null>();
  const samples = events.slice(0, 5000);
  for (const event of samples) {
    const at = Date.parse(event.startedAt);
    if (!Number.isFinite(at)) continue;
    const key = day(at);
    const value = metric === 'aic' ? event.nanoAiu == null ? null : event.nanoAiu / 1e9
      : event.inputTokens + event.outputTokens + event.reasoningOutputTokens;
    const previous = days.has(key) ? days.get(key)! : 0;
    days.set(key, previous == null || value == null ? null : previous + value);
  }
  return <section aria-label="Scoped usage trends">
    <label>Metric <select className="input" value={metric} onChange={(event) => setMetric(event.target.value)}><option value="aic">AIC</option><option value="tokens">Tokens</option></select></label>
    <HistoryChart title="Recorded daily usage" unit={metric === 'aic' ? 'AIC' : 'tokens'} maxGapMs={86400000}
      explain={`UTC totals from ${samples.length} already-loaded records (maximum 5,000). This is not a retained-billing rollup; missing dates or billing stay unavailable. No additional event history is fetched.`}
      points={[...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({
        id: date, label: date, at: Date.parse(date), value,
      }))} />
  </section>;
}

export function UsageInsights({ scope, signal, window: suppliedWindow }: {
  scope: 'workspace' | 'ide'; signal: number; window?: UsageWindow;
}) {
  const api = useApi();
  const visibility = useInsightVisibility();
  const [customWindow, setWindow] = useState(() => ({ from: day(Date.now() - 29 * 86400000), to: day(Date.now() + 86400000) }));
  const window = suppliedWindow ?? customWindow;
  const [view, setView] = useState('calendar');
  const [metric, setMetric] = useState('aic');
  const [selected, setSelected] = useState('');
  const key = JSON.stringify([scope, window]);
  const start = Date.parse(window.from);
  const end = Date.parse(window.to);
  const valid = Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 366 * 86400000;
  const [state, setState] = useState<{ key: string; data?: UsageRollup; error?: string }>({ key: '' });
  useEffect(() => { setSelected(''); }, [key]);
  useEffect(() => {
    if (!visibility.visible) return;
    let active = true;
    if (!valid) { setState({ key }); return; }
    setState((previous) => previous.key === key ? { ...previous, error: undefined } : { key });
    const request = sharedRead(api, JSON.stringify(['calendar', key, signal, visibility.revision]), () =>
      scope === 'ide' ? api.getIdeUsageRollup('day', window) : api.getUsageRollup('day', window));
    void request.then((data) => { if (active) setState({ key, data }); })
      .catch((cause: unknown) => { if (active) setState((previous) => ({ ...previous, key,
        error: cause instanceof Error ? cause.message : 'Could not load usage insights' })); });
    return () => { active = false; };
  }, [api, key, scope, window, signal, valid, visibility.visible, visibility.revision]);
  const data = state.key === key ? state.data : undefined;
  const value = (period: UsageRollup['periods'][number]) => metric === 'aic'
    ? period.nanoAiu == null ? null : period.nanoAiu / 1e9
    : period.inputTokens + period.outputTokens + period.reasoningOutputTokens;
  const periods = data?.periods ?? [];
  const byDay = new Map(periods.map((period) => [period.start, period]));
  const weeks: MatrixRow[] = [];
  if (valid) for (let at = start; at < end; at += 7 * 86400000) {
    weeks.push({ id: String(at), label: day(at), cells: Array.from({ length: 7 }, (_, index) => {
      const time = at + index * 86400000;
      const date = day(time);
      const period = time < end ? byDay.get(date) : undefined;
      const total = period ? value(period) : null;
      return { value: total, text: time >= end ? 'Outside window' : period
        ? `${date}: ${total == null ? 'Unavailable' : total.toLocaleString()}`
        : `${date}: Not recorded`, select: period ? () => setSelected(date) : undefined };
    }) });
  }
  const detail = byDay.get(selected);
  return <section aria-label="Usage insights">
    <div className="monitor-controls">
      {!suppliedWindow && <><label>From (UTC)<input className="input" type="date" value={window.from} onChange={(event) => setWindow({ ...window, from: event.target.value })} /></label>
      <label>To (UTC, exclusive)<input className="input" type="date" value={window.to} onChange={(event) => setWindow({ ...window, to: event.target.value })} /></label></>}
      <label>View<select className="input" value={view} onChange={(event) => setView(event.target.value)}><option value="calendar">Calendar</option><option value="trend">Trend</option></select></label>
      <label>Metric<select className="input" value={metric} onChange={(event) => setMetric(event.target.value)}><option value="aic">AIC</option><option value="tokens">Tokens</option></select></label>
    </div>
    <p className="field-hint">{suppliedWindow ? 'Follows the selected Usage time frame.' : 'Only this insight uses the selected UTC window, up to 366 days.'} Retained day totals cannot provide local-hour detail.
      Empty days are not verified zero activity. Session bucket counts are not additive unique sessions.</p>
    {!valid && <p role="alert">Choose a valid UTC window of 1-366 days.</p>}
    {state.key === key && state.error && <p role="status">{data && 'Showing previous snapshot. '}{state.error}</p>}
    {!data && valid && !state.error && <p role="status">Loading usage insights...</p>}
    {data && (view === 'calendar' ? <InsightMatrix title={`${scope} daily activity`} columns={['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7']}
      explanation={`Daily ${metric === 'aic' ? 'AIC' : 'tokens'}, aligned to the selected start date. Select a measured day for its recorded totals.`} rows={weeks} />
      : <HistoryChart title={`${scope} usage trend`} unit={metric === 'aic' ? 'AIC' : 'tokens'} maxGapMs={86400000}
        explain="UTC day totals. Lines break at missing days; incomplete billing remains unavailable."
        points={periods.map((period) => ({ id: period.key, label: period.start, at: Date.parse(period.start), value: value(period), select: () => setSelected(period.start) }))} />)}
    {detail && <div role="status"><h4>{selected} recorded totals</h4>
      <p>{formatAic(detail.nanoAiu)} AIC · {detail.inputTokens.toLocaleString()} input tokens · {detail.outputTokens.toLocaleString()} output tokens.
        Retained totals may outlive their session details.</p>
      {scope === 'ide' && <Insights title="Source operations for this UTC day">{() => <OperationInsights scope={{
        from: new Date(selected).toISOString(), to: new Date(Date.parse(selected) + 86400000).toISOString(),
      }} />}</Insights>}
    </div>}
  </section>;
}
