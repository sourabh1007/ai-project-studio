import { useState } from 'react';
import type { MetaPoolsStatus } from '../../lib/types.js';
import { HistoryChart } from '../monitoring/insights.js';

export function CapacityInsights({ status }: { status: MetaPoolsStatus }) {
  const [metric, setMetric] = useState<'queued' | 'processes' | 'busy' | 'idle' | 'warming'>('queued');
  const [route, setRoute] = useState('');
  const samples = status.history?.samples ?? [];
  const routes = [...new Set(samples.map((point) => JSON.stringify([point.provider, point.model])))];
  const effective = routes.includes(route) ? route : routes.at(-1);
  return <section aria-label="Capacity history">
    <div className="monitor-controls"><label>Metric <select className="input" value={metric} onChange={(event) => setMetric(event.target.value as typeof metric)}>
      <option value="queued">Shared process queue</option><option value="processes">Reserved processes</option>
      <option value="busy">Warm busy</option><option value="idle">Warm idle</option><option value="warming">Warming</option>
    </select></label>
      <label>Recorded provider/model <select className="input" value={effective ?? ''} onChange={(event) => setRoute(event.target.value)}>
        {routes.map((id) => <option key={id} value={id}>{(JSON.parse(id) as (string | null)[]).map((part) => part ?? 'unknown').join(' / ')}</option>)}
      </select></label></div>
    {status.history?.error && <p role="status">{status.history.error}</p>}
    <HistoryChart title="Execution capacity" unit="count" maxGapMs={180000}
      explain={`Shared admission counts are not per-model queue times. Warm idle capacity does not imply a named-model cold request can use it. Limits: ${status.processAdmission?.maxProcesses ?? 'unknown'} processes, ${status.processAdmission?.maxQueued ?? 'unknown'} queued. History uses the existing backend sampling cadence.`}
      points={samples.filter((point) => JSON.stringify([point.provider, point.model]) === effective).map((point) => ({
        id: String(point.at), label: new Date(point.at).toLocaleString(), at: point.at, value: point[metric],
      }))} />
  </section>;
}
