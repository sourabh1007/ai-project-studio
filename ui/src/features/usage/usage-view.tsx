import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  MetaUsageActivity,
  ModelBreakdown,
  ProviderBreakdown,
  UsageGranularity,
  UsagePeriod,
  UsageRollup,
} from '../../lib/types.js';
import { useUsageExplorer } from '../../hooks/use-usage-rollups.js';
import {
  formatAic,
  formatCredits,
  formatDateTime,
  formatTokens,
  nanoAiuToAic,
} from '../../lib/format.js';
import { AiIcon, ClockIcon, McpIcon, UsageIcon, WorkspaceContextIcon } from '../../components/icons.js';
import { McpUsageCharts } from '../../components/mcp-usage-charts.js';
import { SkillUsage } from '../../components/skill-usage.js';
import { Insights } from '../monitoring/insights.js';
import { UsageInsights } from './usage-insights.js';
import { OperationInsights } from '../meta-operations/operation-insights.js';
import { useMotion } from '../../hooks/use-motion.js';
import { PromptUsage, type PromptUsageTarget } from './prompt-usage.js';
import { BrandedLoader, LoadingStatus } from '../../components/loading.js';

type Scope = 'workspace' | 'ide';

const GRANULARITIES: { id: UsageGranularity; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
];

/**
 * Consolidated, exploreable IDE usage: billable workspace dev spend and the
 * IDE's own metasession overhead in a selected UTC calendar period. Totals
 * include corresponding usage retained from deleted sessions/features.
 * Kept deliberately simple — pick a time frame and a scope,
 * then drill into periods, models, providers and (for the IDE) exactly what
 * each metasession spent credits on.
 */
export function UsageView({ signal, promptTarget }: { signal: number; promptTarget?: PromptUsageTarget }) {
  const [granularity, setGranularity] = useState<UsageGranularity>('month');
  const [scope, setScope] = useState<Scope>('workspace');
  const state = useUsageExplorer(granularity, signal);
  const rollup = scope === 'workspace' ? state.workspace : state.ide;

  return (
    <div className="dashboard usage-explorer">
      <header className="dash-header">
        <h2 className="dash-title">Usage</h2>
        <p className="dash-description">
          Recorded AI usage in the selected calendar period, including retained
          usage from deleted features and sessions. Calendar periods use UTC.
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
        <div className="usage-granularity" role="group" aria-label="Usage time frame">
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

      <p className="field-hint">
        Showing {state.window.from} to {state.window.to} (UTC, end exclusive).
        {state.loading && rollup && ' Updating the selected time frame; the previous window remains visible until it loads.'}
      </p>
      {state.loading && rollup && <LoadingStatus label="Refreshing usage; showing previous results" />}

      {state.error && (
        <div className="dash-empty">
          <p className="muted" role="status">
            {rollup ? "Couldn't refresh usage; showing the last snapshot: " : "Couldn't load usage: "}{state.error}
          </p>
        </div>
      )}

      <PromptUsage window={state.window} signal={signal} target={promptTarget} />
      {rollup && (
        <>
          <Totals rollup={rollup} />
          <PeriodBreakdown periods={rollup.periods} granularity={state.granularity} />
          <div className="usage-split">
            <ModelTable rows={rollup.byModel} />
            <ProviderTable rows={rollup.byProvider} />
          </div>
          <Section icon={<McpIcon size={16} />} title="MCP servers"
            hint={scope === 'ide' ? 'IDE metasession tool usage' : 'Workspace tool usage'}>
            <McpUsageCharts rows={rollup.byMcpServer} scope={scope === 'ide' ? 'internal' : 'feature'} />
          </Section>
        </>
      )}
      <Insights title="Activity calendar and trends">{() => <UsageInsights scope={scope} signal={signal} window={state.window} />}</Insights>
      <SkillUsage scope={scope === 'ide' ? 'internal' : 'feature'} signal={signal} window={state.window} />

      {scope === 'ide' && (
        <><Insights title="Operation timing and model comparisons">{() => <OperationInsights scope={{
          from: `${state.window.from}T00:00:00.000Z`, to: `${state.window.to}T00:00:00.000Z`,
        }} signal={signal} />}</Insights>
        <ActivityFeed records={state.activity?.records ?? []} /></>
      )}

      {!rollup && !state.error && (
        <BrandedLoader title="Loading usage" detail="Reading workspace usage, IDE usage and activity"
          progress={state.progress} />
      )}
    </div>
  );
}

function Totals({ rollup }: { rollup: UsageRollup }) {
  const t = rollup.totals;
  return (
    <section className="dash-kpis usage-kpis">
      <Kpi value={t.nanoAiu} format={formatAic} label="AI credits (AIC)" accent="var(--accent)" />
      <Kpi value={t.credits} format={formatCredits} label="Vendor credits" accent="#8b5cf6" />
      {t.usdEstimate !== undefined && t.usdEstimate !== null && (
        <Kpi value={t.usdEstimate} format={(value) => `$${value!.toFixed(4)}`} label="USD estimate (not AIC)" accent="#8b5cf6" />
      )}
      <Kpi value={t.sessions} format={(value) => String(Math.round(value!))} label="Sessions" accent="#0ea5e9" />
      <Kpi value={t.inputTokens} format={(value) => formatTokens(Math.round(value!))} label="Input tokens" accent="#22c55e" />
      <Kpi value={t.outputTokens} format={(value) => formatTokens(Math.round(value!))} label="Output tokens" accent="#f59e0b" />
    </section>
  );
}

function Kpi({ value, format, label, accent }: {
  value: number | null; format: (value: number | null) => string; label: string; accent: string;
}) {
  const motion = useMotion();
  const [shown, setShown] = useState(value);
  const current = useRef(value);
  useEffect(() => {
    if (motion !== 'full' || value === null || current.current === null) {
      current.current = value;
      setShown(value);
      return;
    }
    const from = current.current;
    if (from === value) return;
    const start = performance.now();
    let frame: number;
    const tick = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - start) / 400));
      const next = progress === 1 ? value : from + (value - from) * (1 - (1 - progress) ** 3);
      current.current = next;
      setShown(next);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, motion]);
  const displayed = value === null || shown === null || motion !== 'full' ? value : shown;
  return (
    <div className="dash-kpi" role="group" aria-label={`${label}: ${format(value)}`}>
      <span className="dash-kpi-bar" style={{ background: accent }} />
      <span className="dash-kpi-value" aria-hidden="true">{format(displayed)}</span>
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
    () => periods.reduce((m, p) => Math.max(m, p.nanoAiu ?? 0), 0),
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
          const pct = max > 0 && p.nanoAiu !== null ? Math.round((p.nanoAiu / max) * 100) : 0;
          return (
            <div className="usage-period-row" key={p.key} title={`${p.start} → ${p.end}`}>
              <span className="usage-period-label">{p.label}</span>
              <span className="dash-bar-track usage-period-bar" aria-hidden="true">
                <span className="dash-bar-fill" style={{ width: `${pct}%` }} />
              </span>
              <span className="usage-period-value dash-num">{aic?.toFixed(2) ?? 'Unavailable'} AIC</span>
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
  const maxNanoAiu = useMemo(
    () => rows.reduce((max, r) => Math.max(max, r.nanoAiu ?? 0), 0),
    [rows],
  );
  return (
    <Section icon={<WorkspaceContextIcon size={16} />} title="By provider">
      {rows.length === 0 ? (
        <p className="muted">No provider usage yet.</p>
      ) : (
        <>
          <div className="usage-provider-graph">
            {rows.map((r) => {
              const pct =
                maxNanoAiu > 0 && r.nanoAiu !== null ? Math.round((r.nanoAiu / maxNanoAiu) * 100) : 0;
              return (
                <div className="usage-provider-row" key={r.provider}>
                  <span className="usage-provider-label">{r.provider}</span>
                  <span
                    className="dash-bar-track usage-provider-bar"
                    aria-hidden="true"
                  >
                    <span
                      className="dash-bar-fill"
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="usage-provider-value dash-num">
                    {formatAic(r.nanoAiu)}
                  </span>
                </div>
              );
            })}
          </div>
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
        </>
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
      title="Recent metasession usage captures"
      hint="Recent captures within the selected UTC window, most recent first. This bounded feed is not the complete retained usage ledger."
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
