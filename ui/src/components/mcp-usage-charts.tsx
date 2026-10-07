import { Fragment, useState } from 'react';
import type { McpServerBreakdown, McpToolBreakdown } from '../lib/types.js';
import { formatAic, formatBytes, formatCompactNumber, formatCredits, formatDateTime, formatDuration, formatTokens } from '../lib/format.js';

type Metric = 'calls' | 'bytes' | 'tokens' | 'credits';
const METRICS: { id: Metric; label: string }[] = [
  { id: 'calls', label: 'Calls' }, { id: 'bytes', label: 'Traffic' },
  { id: 'tokens', label: 'Tokens' }, { id: 'credits', label: 'AI credits' },
];
const COLORS = ['var(--accent)', 'var(--success)', 'var(--warning)', 'var(--text-muted)'];
const UNAVAILABLE = 'Not reported';

function valueOf(row: McpServerBreakdown, metric: Metric): number | null {
  if (metric === 'calls') return row.calls;
  if (metric === 'bytes') return row.inputBytes + row.outputBytes;
  if (metric === 'credits') return row.nanoAiu ?? null;
  return row.inputTokens == null || row.outputTokens == null ? null : row.inputTokens + row.outputTokens;
}

function formatted(value: number | null, metric: Metric): string {
  if (value === null) return UNAVAILABLE;
  if (metric === 'bytes') return formatBytes(value);
  if (metric === 'credits') return `${formatAic(value)} AIC`;
  return metric === 'tokens' ? formatTokens(value) : formatCompactNumber(value);
}

function label(row: McpServerBreakdown) {
  return row.provider ? `${row.server} (${row.provider})` : row.server;
}

export function McpUsageCharts({ rows }: { rows: McpServerBreakdown[] }) {
  const [metric, setMetric] = useState<Metric>('calls');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (key: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  const ranked = [...rows].sort((a, b) =>
    (valueOf(b, metric) ?? -1) - (valueOf(a, metric) ?? -1) || label(a).localeCompare(label(b)));
  const byCalls = [...rows].sort((a, b) => b.calls - a.calls || label(a).localeCompare(label(b)));
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  const max = Math.max(1, ...rows.map((row) => valueOf(row, metric) ?? 0));
  const leader = byCalls.find((row) => row.calls > 0);
  const measuredCredits = rows.filter((row) => row.nanoAiu != null);
  const partialCredits = measuredCredits.length !== rows.length || rows.some((row) => row.attribution === 'partial');
  const knownCredits = measuredCredits.reduce((sum, row) => sum + row.nanoAiu!, 0);
  const reported = (value: number | null | undefined, format: (value: number) => string) =>
    value == null ? UNAVAILABLE : format(value);

  if (rows.length === 0) {
    return <div className="mcp-usage-empty">
      <p className="muted">No MCP activity yet.</p>
      <p className="field-hint">No attributable calls were captured in this scope. Unavailable telemetry is not zero usage.</p>
    </div>;
  }
  return <div className="mcp-usage-charts">
    <div className="mcp-usage-summary">
      <div><strong>{formatCompactNumber(calls)}</strong><span>Tool calls</span></div>
      <div><strong>{rows.length}</strong><span>Server connections</span></div>
      <div><strong>{leader ? label(leader) : 'None recorded'}</strong><span>Most used by calls</span></div>
      <div><strong>{measuredCredits.length ? `${formatAic(knownCredits)}${partialCredits ? '+' : ''}` : UNAVAILABLE}</strong>
        <span>{partialCredits && measuredCredits.length ? 'AIC (partial)' : 'Reported AIC'}</span></div>
    </div>
    <p className="field-hint">Tokens and credits appear only when explicitly attributed to an MCP server. They are not estimated from traffic or allocated from session totals.</p>
    <div className="mcp-usage-chart-grid">
      <figure className="mcp-ranking">
        <figcaption>Server ranking</figcaption>
        <div className="usage-granularity" role="group" aria-label="Rank MCP servers by">
          {METRICS.map((item) => <button key={item.id} type="button"
            className={`usage-seg ${metric === item.id ? 'is-active' : ''}`}
            aria-pressed={metric === item.id} onClick={() => setMetric(item.id)}>{item.label}</button>)}
        </div>
        <ol className="mcp-ranking-list" aria-label={`MCP server ranking by ${metric}`}>
          {ranked.slice(0, 10).map((row) => {
            const value = valueOf(row, metric);
            return <li key={label(row)}>
              <span className="mcp-ranking-name" title={label(row)}>{label(row)}</span>
              <span className="dash-bar-track" aria-hidden="true">
                <span className="dash-bar-fill" style={{ width: `${((value ?? 0) / max) * 100}%` }} />
              </span>
              <span className="dash-num">{formatted(value, metric)}{value !== null && row.attribution === 'partial' && (metric === 'tokens' || metric === 'credits') ? ' (partial)' : ''}</span>
            </li>;
          })}
        </ol>
        {rows.length > 10 && <p className="field-hint">Top 10 shown; all servers are listed below.</p>}
      </figure>
      <figure className="mcp-call-share">
        <figcaption>Tool-call share</figcaption>
        <div className="mcp-share-bar" aria-hidden="true">
          {byCalls.map((row, index) => <span key={label(row)} style={{
            width: `${calls ? row.calls / calls * 100 : 0}%`, background: COLORS[index % COLORS.length],
          }} />)}
        </div>
        <ul aria-label="MCP tool-call share">
          {byCalls.map((row, index) => <li key={label(row)}>
            <i aria-hidden="true" style={{ background: COLORS[index % COLORS.length] }} />
            <span title={label(row)}>{label(row)}</span>
            <span className="dash-num">{calls ? (row.calls / calls * 100).toFixed(1) : '0.0'}%</span>
          </li>)}
        </ul>
      </figure>
    </div>
    <div className="mcp-usage-table-scroll" tabIndex={0} role="region" aria-label="MCP server usage details">
      <table className="usage-table" aria-label="MCP server I/O">
        <thead><tr><th>Server</th><th>Source</th><th>Calls</th><th>Input tokens</th><th>Output tokens</th>
          <th>AIC</th><th>Vendor credits</th><th>Traffic in / out</th><th>Total time</th><th>Last used</th></tr></thead>
        <tbody>{ranked.map((row) => {
          const key = label(row);
          const tools = row.tools ?? [];
          const isOpen = expanded.has(key);
          return <Fragment key={key}>
            <tr className={tools.length > 0 ? 'mcp-usage-row-expandable' : undefined}>
              <td title={key}>
                {tools.length > 0
                  ? <button type="button" className="mcp-usage-expand" aria-expanded={isOpen}
                      onClick={() => toggleExpanded(key)}>
                      <span className="mcp-usage-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                      {row.server}
                    </button>
                  : row.server}
                {row.provider && <small className="mcp-usage-provider">{row.provider}</small>}
              </td>
              <td>{row.origin === 'built-in' ? 'CLI built-in' : row.origin === 'configured' ? 'Configured' : 'Not identified'}</td>
              <td className="dash-num">{formatCompactNumber(row.calls)}</td>
              <td className="dash-num">{reported(row.inputTokens, formatTokens)}</td>
              <td className="dash-num">{reported(row.outputTokens, formatTokens)}</td>
              <td className="dash-num">{reported(row.nanoAiu, formatAic)}{row.attribution === 'partial' && row.nanoAiu != null ? ' (partial)' : ''}</td>
              <td className="dash-num">{reported(row.credits, formatCredits)}</td>
              <td className="dash-num">{formatBytes(row.inputBytes)} / {formatBytes(row.outputBytes)}</td>
              <td className="dash-num">{formatDuration(row.durationMs)}</td>
              <td className="dash-num">{formatDateTime(row.lastCallAt ?? null)}</td>
            </tr>
            {isOpen && <tr className="mcp-usage-tools-row">
              <td colSpan={10}>
                <ToolBreakdownTable tools={tools} />
              </td>
            </tr>}
          </Fragment>;
        })}</tbody>
      </table>
    </div>
  </div>;
}

/** Per-tool detail shown when a server row is expanded. */
function ToolBreakdownTable({ tools }: { tools: McpToolBreakdown[] }) {
  return <table className="usage-table mcp-usage-tools" aria-label="Per-tool calls">
    <thead><tr><th>Tool</th><th>Calls</th><th>First used</th><th>Last used</th></tr></thead>
    <tbody>{tools.map((tool) => <tr key={tool.tool}>
      <td title={tool.tool}>{tool.tool}</td>
      <td className="dash-num">{formatCompactNumber(tool.calls)}</td>
      <td className="dash-num">{tool.firstCallAt ? formatDateTime(tool.firstCallAt) : UNAVAILABLE}</td>
      <td className="dash-num">{tool.lastCallAt ? formatDateTime(tool.lastCallAt) : UNAVAILABLE}</td>
    </tr>)}</tbody>
  </table>;
}
