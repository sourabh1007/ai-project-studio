import { useEffect, useState, type ReactNode } from 'react';
import './monitoring.css';

export function useInsightVisibility() {
  const [state, setState] = useState({ visible: document.visibilityState !== 'hidden', revision: 0 });
  useEffect(() => {
    const change = () => setState((previous) => ({
      visible: document.visibilityState !== 'hidden', revision: previous.revision + 1,
    }));
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  return state;
}

export function Insights({ title = 'Insights', children }: { title?: string; children: ReactNode | (() => ReactNode) }) {
  const [open, setOpen] = useState(false);
  return <details className="monitor-insights" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{title}</summary>
    {open && <div className="monitor-body">{typeof children === 'function' ? children() : children}</div>}
  </details>;
}

export interface MatrixCell {
  value: number | null;
  text?: string;
  state?: string;
  select?: () => void;
}
export interface MatrixRow { id: string; label: string; cells: MatrixCell[] }

export function InsightMatrix({ title, columns, rows, explanation, intensity = true }: {
  title: string; columns: string[]; rows: MatrixRow[]; explanation: string; intensity?: boolean;
}) {
  const [page, setPage] = useState(0);
  const size = Math.max(1, Math.min(60, Math.floor(600 / Math.max(1, columns.length))));
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(page, pages - 1);
  const visible = rows.slice(current * size, (current + 1) * size);
  const max = Math.max(1, ...visible.flatMap((row) => row.cells.map((cell) => cell.value ?? 0)));
  return <section className="monitor-chart" aria-label={title}>
    <h4>{title}</h4>
    <p className="field-hint">{explanation}</p>
    {!rows.length ? <p role="status">No recorded data in this scope. Missing telemetry is not a measured zero.</p>
      : <div className="monitor-scroll" role="region" aria-label={`${title} table`} tabIndex={0}>
        <table className="usage-table monitor-matrix"><thead><tr><th scope="col">Subject</th>
          {columns.map((label, index) => <th scope="col" key={index}>{label}</th>)}</tr></thead>
          <tbody>{visible.map((row) => <tr key={row.id}><th scope="row">{row.label}</th>
            {row.cells.map((cell, index) => <td key={index} data-state={cell.state}
              style={{ background: intensity && cell.value != null && cell.value > 0
                ? `color-mix(in srgb, var(--accent) ${15 + 55 * cell.value / max}%, transparent)` : undefined }}>
              {cell.select ? <button type="button" className="rb-linkish"
                aria-label={`${row.label}, ${columns[index]}: ${cell.text ?? cell.value ?? 'Unavailable'}`}
                onClick={cell.select}>{cell.text ?? cell.value ?? 'Unavailable'}</button>
                : cell.text ?? cell.value ?? 'Unavailable'}
            </td>)}</tr>)}</tbody></table>
      </div>}
    {pages > 1 && <div className="monitor-controls" aria-label={`${title} pages`}>
      <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button>
      <span>{current + 1} / {pages} · {rows.length} subjects</span>
      <button type="button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>Next</button>
    </div>}
  </section>;
}

export interface HistoryPoint { id: string; label: string; at: number; value: number | null; select?: () => void }

export function HistoryChart({ title, unit, points, maxGapMs = Infinity, explain }: {
  title: string; unit: string; points: HistoryPoint[]; maxGapMs?: number; explain: string;
}) {
  const [table, setTable] = useState(false);
  const data = points.slice(-600);
  const measured = data.filter((point) => Number.isFinite(point.at) && point.value != null && Number.isFinite(point.value));
  const maximum = measured.length ? Math.max(...measured.map((point) => point.value!)) : null;
  const max = Math.max(1, ...measured.map((point) => point.value!));
  const times = data.filter((point) => Number.isFinite(point.at)).map((point) => point.at);
  const from = times.length ? Math.min(...times) : 0;
  const span = Math.max(1, (times.length ? Math.max(...times) : from) - from);
  let previous: HistoryPoint | undefined;
  const path = data.map((point) => {
    if (!Number.isFinite(point.at) || point.value == null || !Number.isFinite(point.value)) { previous = undefined; return ''; }
    const command = !previous || point.at - previous.at > maxGapMs || point.at < previous.at ? 'M' : 'L';
    previous = point;
    return `${command}${10 + 580 * (point.at - from) / span},${100 - 90 * point.value / max}`;
  }).join(' ');
  return <section className="monitor-chart" aria-label={title}>
    <h4>{title} <small>({unit})</small></h4>
    <p className="field-hint">{explain}</p>
    {points.length > 600 && <p>Showing the latest 600 points.</p>}
    {measured.length > 0 && <p className="field-hint">{data.find((point) => point.at === from)?.label} — {data.find((point) => point.at === from + span)?.label ?? data.find((point) => point.at === from)?.label}
      {' · '}maximum {maximum!.toLocaleString()} {unit} · {measured.length}/{data.length} measured</p>}
    {measured.length ? <svg viewBox="0 0 600 115" role="img" aria-label={`${title}: ${measured.length} measured of ${data.length} points, maximum ${maximum!.toLocaleString()} ${unit}`}>
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" />
      {measured.map((point) => <circle key={point.id} cx={10 + 580 * (point.at - from) / span}
        cy={100 - 90 * point.value! / max} r="3" fill="var(--accent)"><title>{point.label}: {point.value} {unit}</title></circle>)}
    </svg> : <p role="status">No measured samples yet.</p>}
    <button type="button" className="rb-linkish" aria-expanded={table} onClick={() => setTable(!table)}>Data table</button>
    {table && <InsightMatrix title={`${title} samples`} columns={[unit]} explanation="Values are measured at the displayed time; unavailable samples are not zero."
      rows={data.map((point) => ({ id: point.id, label: point.label, cells: [{ value: point.value, select: point.select }] }))} />}
  </section>;
}

export interface TimelineItem {
  id: string; label: string; status: string; start: number | null; end: number | null;
  durationMs?: number | null; select?: () => void;
}
export function ExecutionTimeline({ items, now = Date.now(), title = 'Execution timeline' }: {
  items: TimelineItem[]; now?: number; title?: string;
}) {
  const valid = items.filter((item) => item.start != null && Number.isFinite(item.start));
  const active = (item: TimelineItem) => ['running', 'busy', 'warming', 'checking', 'acting', 'generating', 'implementing'].includes(item.status);
  const end = (item: TimelineItem) => item.end != null && Number.isFinite(item.end) && item.end >= item.start!
    ? item.end : active(item) ? Math.max(item.start!, now) : item.start!;
  const from = Math.min(now, ...valid.map((item) => item.start!));
  const to = Math.max(from + 1, ...valid.map(end));
  return <section className="monitor-chart" aria-label={title}>
    <h4>{title}</h4>
    <p className="field-hint">Recorded execution boundaries. Running spans are provisional. Parallel lane durations are not total wall time. Queue time is unavailable unless separately measured.</p>
    <InsightMatrix title="Attempts and outcomes" columns={['State', 'Timing']} explanation="Rows without recorded boundaries remain unavailable; completion is not proof of correctness."
      rows={items.map((item) => {
        const duration = item.durationMs != null && Number.isFinite(item.durationMs) && item.durationMs >= 0 ? item.durationMs
          : item.start != null && Number.isFinite(item.start) && item.end != null && Number.isFinite(item.end) && item.end >= item.start ? item.end - item.start : null;
        return { id: item.id, label: item.label, cells: [
          { value: null, text: item.status, state: item.status, select: item.select },
          { value: duration, text: duration == null ? item.start == null || !Number.isFinite(item.start) ? 'Not recorded' : active(item) ? 'In progress' : 'End boundary unavailable' : `${(duration / 1000).toFixed(2)} s` },
        ] };
      })} />
    <div className="monitor-lanes" aria-hidden="true">{valid.slice(0, 60).map((item) => <div key={item.id}>
      <span>{item.label}</span><div className="monitor-lane"><i style={{
        marginInlineStart: `${Math.max(0, 100 * (item.start! - from) / (to - from))}%`,
        width: `${Math.max(0.5, Math.min(100, 100 * Math.max(0, end(item) - item.start!) / (to - from)))}%`,
      }} /></div>
    </div>)}</div>
    {valid.length > 60 && <p className="field-hint">First 60 lanes drawn; all attempts are available in the paginated table.</p>}
  </section>;
}
