import { useMemo, useState } from 'react';
import type {
  MetaUsageActivity,
  McpServerBreakdown,
  ModelBreakdown,
  ProviderBreakdown,
  UsageGranularity,
  UsagePeriod,
  UsageRollup,
} from '../../lib/types.js';
import { useUsageExplorer } from '../../hooks/use-usage-rollups.js';
import {
  formatAic,
  formatBytes,
  formatCompactNumber,
  formatCredits,
  formatDateTime,
  formatDuration,
  formatTokens,
  nanoAiuToAic,
} from '../../lib/format.js';
import { AiIcon, ClockIcon, McpIcon, UsageIcon, WorkspaceContextIcon } from '../../components/icons.js';

type Scope = 'workspace' | 'ide';

const GRANULARITIES: { id: UsageGranularity; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
];

/**
 * Consolidated, exploreable IDE usage: billable workspace dev spend and the
 * IDE's own metasession overhead, rolled up by day/week/month/year. Every total
 * folds in usage retained from deleted sessions/features and all metasession
 * credits, so figures reconcile with the plan budget and never shrink when
 * history is pruned. Kept deliberately simple — pick a granularity and a scope,
 * then drill into periods, models, providers and (for the IDE) exactly what
 * each metasession spent credits on.
 */
export function UsageView({ signal }: { signal: number }) {
  const [granularity, setGranularity] = useState<UsageGranularity>('month');
  const [scope, setScope] = useState<Scope>('workspace');
  const state = useUsageExplorer(granularity, signal);
  const rollup = scope === 'workspace' ? state.workspace : state.ide;

  return (
    <div className="dashboard usage-explorer">
      <header className="dash-header">
        <h2 className="dash-title">Usage</h2>
        <p className="dash-description">
          Consolidated AI usage across the whole studio. Totals include work
          retained from deleted features and sessions, plus every metasession —
          so what you see here reconciles with your plan budget.
        </p>
      </header>

      <div className="usage-controls">
        <div className="usage-tabs" role="tablist" aria-label="Usage scope">
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'workspace'}
            className={`usage-tab ${scope === 'workspace' ? 'is-active' : ''}`.trim()}
            onClick={() => setScope('workspace')}
          >
            <WorkspaceContextIcon size={14} /> Workspace
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'ide'}
            className={`usage-tab ${scope === 'ide' ? 'is-active' : ''}`.trim()}
            onClick={() => setScope('ide')}
          >
            <AiIcon size={14} /> IDE metasessions
          </button>
        </div>
        <div className="usage-granularity" role="group" aria-label="Granularity">
          {GRANULARITIES.map((g) => (
            <button
              key={g.id}
              type="button"
              aria-pressed={granularity === g.id}
              className={`usage-seg ${granularity === g.id ? 'is-active' : ''}`.trim()}
              onClick={() => setGranularity(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {state.error && !rollup && (
        <div className="dash-empty">
          <p className="muted" role="status">
            Couldn't load usage: {state.error}
          </p>
        </div>
      )}

      {rollup && (
        <>
          <Totals rollup={rollup} />
          <PeriodBreakdown periods={rollup.periods} granularity={granularity} />
          <div className="usage-split">
            <ModelTable rows={rollup.byModel} />
            <ProviderTable rows={rollup.byProvider} />
          </div>
          <McpServers rows={rollup.byMcpServer} scope={scope} />
        </>
      )}

      {scope === 'ide' && (
        <ActivityFeed records={state.activity?.records ?? []} />
      )}

      {!rollup && !state.error && (
        <p className="muted" role="status">
          Loading usage…
        </p>
      )}
    </div>
  );
}

function Totals({ rollup }: { rollup: UsageRollup }) {
  const t = rollup.totals;
  return (
    <section className="dash-kpis usage-kpis">
      <Kpi value={formatAic(t.nanoAiu)} label="AI credits (AIC)" accent="var(--accent)" />
      <Kpi value={formatCredits(t.credits)} label="Vendor credits" accent="#8b5cf6" />
      <Kpi value={String(t.sessions)} label="Sessions" accent="#0ea5e9" />
      <Kpi value={formatTokens(t.inputTokens)} label="Input tokens" accent="#22c55e" />
      <Kpi value={formatTokens(t.outputTokens)} label="Output tokens" accent="#f59e0b" />
    </section>
  );
}

function Kpi({ value, label, accent }: { value: string; label: string; accent: string }) {
  return (
    <div className="dash-kpi">
      <span className="dash-kpi-bar" style={{ background: accent }} />
      <span className="dash-kpi-value">{value}</span>
      <span className="dash-kpi-label">{label}</span>
    </div>
  );
}

function PeriodBreakdown({
  periods,
  granularity,
}: {
  periods: UsagePeriod[];
  granularity: UsageGranularity;
}) {
  const max = useMemo(
    () => periods.reduce((m, p) => Math.max(m, p.nanoAiu), 0),
    [periods],
  );
  if (periods.length === 0) {
    return (
      <Section icon={<UsageIcon size={16} />} title="By period">
        <p className="muted">No usage recorded in this window yet.</p>
      </Section>
    );
  }
  return (
    <Section
      icon={<UsageIcon size={16} />}
      title="By period"
      hint={`Grouped by ${granularity}. Bars scale to the busiest period.`}
    >
      <div className="usage-periods">
        {periods.map((p) => {
          const aic = nanoAiuToAic(p.nanoAiu);
          const pct = max > 0 ? Math.round((p.nanoAiu / max) * 100) : 0;
          return (
            <div className="usage-period-row" key={p.key} title={`${p.start} → ${p.end}`}>
              <span className="usage-period-label">{p.label}</span>
              <span className="dash-bar-track usage-period-bar" aria-hidden="true">
                <span className="dash-bar-fill" style={{ width: `${pct}%` }} />
              </span>
              <span className="usage-period-value dash-num">{aic.toFixed(2)} AIC</span>
              <span className="usage-period-sub muted">{p.sessions} sessions</span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function ModelTable({ rows }: { rows: ModelBreakdown[] }) {
  return (
    <Section icon={<AiIcon size={16} />} title="By model">
      {rows.length === 0 ? (
        <p className="muted">No model usage yet.</p>
      ) : (
        <table className="usage-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="dash-num">AIC</th>
              <th className="dash-num">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.model}>
                <td title={r.model}>{r.model}</td>
                <td className="dash-num">{formatAic(r.nanoAiu)}</td>
                <td className="dash-num">
                  {formatTokens(r.inputTokens + r.outputTokens + r.reasoningOutputTokens)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function ProviderTable({ rows }: { rows: ProviderBreakdown[] }) {
  return (
    <Section icon={<WorkspaceContextIcon size={16} />} title="By provider">
      {rows.length === 0 ? (
        <p className="muted">No provider usage yet.</p>
      ) : (
        <table className="usage-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th className="dash-num">AIC</th>
              <th className="dash-num">Sessions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.provider}>
                <td>{r.provider}</td>
                <td className="dash-num">{formatAic(r.nanoAiu)}</td>
                <td className="dash-num">{r.sessions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

/** Human-readable reason a metasession spent credits. */
function activityReason(record: MetaUsageActivity): string {
  return record.label ?? record.purpose ?? 'Metasession work';
}

function ActivityFeed({ records }: { records: MetaUsageActivity[] }) {
  return (
    <Section
      icon={<ClockIcon size={16} />}
      title="Recent metasession activity"
      hint="What the IDE spent credits on, most recent first — model, purpose and cost."
    >
      {records.length === 0 ? (
        <p className="muted">No metasession activity captured yet.</p>
      ) : (
        <table className="usage-table usage-activity">
          <thead>
            <tr>
              <th>When</th>
              <th>Why</th>
              <th>Model</th>
              <th className="dash-num">AIC</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.sessionId}>
                <td title={r.capturedAt}>{formatDateTime(r.capturedAt)}</td>
                <td title={activityReason(r)}>{activityReason(r)}</td>
                <td>{r.resolvedModel ?? r.requestedModel}</td>
                <td className="dash-num">
                  {r.nanoAiu === null ? '—' : formatAic(r.nanoAiu)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function McpServers({
  rows,
  scope,
}: {
  rows: McpServerBreakdown[];
  scope: Scope;
}) {
  const maxBytes = useMemo(
    () => Math.max(1, ...rows.map((r) => r.inputBytes + r.outputBytes)),
    [rows],
  );
  const hint =
    scope === 'ide'
      ? 'Real tool-call I/O from the IDE’s own metasessions.'
      : 'Real tool-call I/O from your workspace sessions.';
  return (
    <Section icon={<McpIcon size={16} />} title="MCP servers" hint={hint}>
      {rows.length === 0 ? (
        <p className="muted">No MCP tool-call activity recorded yet.</p>
      ) : (
        <table className="usage-table usage-mcp">
          <thead>
            <tr>
              <th>Server</th>
              <th className="dash-num">Calls</th>
              <th className="dash-num">In</th>
              <th className="dash-num">Out</th>
              <th className="dash-num">Latency</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = Math.round(
                ((r.inputBytes + r.outputBytes) / maxBytes) * 100,
              );
              return (
                <tr key={r.server}>
                  <td title={r.server}>
                    <span className="dash-bar-track usage-mcp-bar" aria-hidden="true">
                      <span
                        className="dash-bar-fill"
                        style={{ width: `${pct}%`, background: 'var(--accent)' }}
                      />
                    </span>
                    <span className="usage-mcp-name">{r.server}</span>
                  </td>
                  <td className="dash-num">{formatCompactNumber(r.calls)}</td>
                  <td className="dash-num">{formatBytes(r.inputBytes)}</td>
                  <td className="dash-num">{formatBytes(r.outputBytes)}</td>
                  <td className="dash-num">{formatDuration(r.durationMs)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="dash-section">
      <header className="dash-section-head">
        <span className="dash-section-icon" aria-hidden="true">
          {icon}
        </span>
        <h3 className="dash-section-title">{title}</h3>
        {hint && <span className="dash-section-hint">{hint}</span>}
      </header>
      {children}
    </section>
  );
}
