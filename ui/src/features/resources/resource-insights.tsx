import { useState } from 'react';
import { HistoryChart } from '../monitoring/insights.js';
import type { AppResourceSnapshot } from './resource-types.js';

const metrics = {
  hostCpu: ['Host CPU', '%'], freeMemory: ['Host available RAM', 'MiB'],
  appCpu: ['App CPU', '%'], appMemory: ['App RAM (summed RSS)', 'MiB'],
  eventLoopDelay: ['Backend event-loop delay', 'ms'],
} as const;

export function ResourceInsights({ snapshot, storage = false }: { snapshot: AppResourceSnapshot | null; storage?: boolean }) {
  const [metric, setMetric] = useState<keyof typeof metrics>('hostCpu');
  const [category, setCategory] = useState('app');
  const history = snapshot?.history;
  const selected = snapshot?.storage.categories.find((entry) => entry.kind === category);
  const scope = JSON.stringify((selected?.pathDetails?.map((entry) => entry.path) ?? selected?.paths ?? []).slice().sort());
  const bytes = metric === 'freeMemory' || metric === 'appMemory';
  return <section aria-label={storage ? 'Storage history' : 'Resource history'}>
    {history?.error && <p role="status">{history.error}</p>}
    {!history && <p role="status">History is unavailable from this backend.</p>}
    {storage ? <>
      <label>Storage category <select className="input" value={category} onChange={(event) => setCategory(event.target.value)}>
        {snapshot?.storage.categories.map((entry) => <option key={entry.id} value={entry.kind}>{entry.label}</option>)}
      </select></label>
      <HistoryChart title={`${selected?.label ?? category} storage`} unit="MiB"
        explain="Completed scans for the same recorded paths only. Partial values remain unavailable. Viewing history never starts a scan or cleanup. History is capped at 90 scans."
        points={(history?.storage ?? []).filter((entry) => entry.category === category && entry.scope === scope).map((entry) => ({
          id: String(entry.at), label: new Date(entry.at).toLocaleString(), at: entry.at,
          value: entry.bytes == null ? null : entry.bytes / 1048576,
        }))} />
    </> : <>
      <label>Resource metric <select className="input" value={metric} onChange={(event) => setMetric(event.target.value as typeof metric)}>
        {Object.entries(metrics).map(([id, [label]]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      <HistoryChart title={metrics[metric][0]} unit={metrics[metric][1]} maxGapMs={history?.maxGapMs}
        explain="Machine-wide and app measurements are separate; these are not per-run CPU costs. Gaps are not interpolated. Existing backend sampling is shared by every window. Retention is bounded; older samples expire."
        points={(history?.samples ?? []).map((entry) => ({ id: String(entry.at), label: new Date(entry.at).toLocaleString(),
          at: entry.at, value: entry[metric] == null ? null : entry[metric]! / (bytes ? 1048576 : 1) }))} />
    </>}
  </section>;
}
