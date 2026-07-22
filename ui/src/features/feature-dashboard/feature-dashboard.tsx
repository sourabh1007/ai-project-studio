import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { formatDuration, nanoAiuToAic } from '../../lib/format.js';
import type { FeatureUsage } from '../../lib/types.js';
import { EmptyState, ErrorText } from '../../components/ui.js';

const PALETTE = [
  '#818cf8',
  '#22d3ee',
  '#34d399',
  '#fbbf24',
  '#f472b6',
  '#f87171',
  '#a78bfa',
  '#4ade80',
];
const TOKEN_IN = '#22d3ee';
const TOKEN_OUT = '#818cf8';
const AIC_COLOR = '#818cf8';
const TIME_COLOR = '#34d399';

const numberFmt = new Intl.NumberFormat('en-US');

function color(i: number): string {
  return PALETTE[i % PALETTE.length];
}

function shortId(id: string): string {
  return id.length > 8 ? `…${id.slice(-6)}` : id;
}

function ChartTooltip({
  active,
  payload,
  label,
  unit,
  formatValue,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
  unit?: string;
  formatValue?: (value: number) => string;
}) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  return (
    <div className="dash-tooltip">
      {label && <span className="dash-tooltip-label">{label}</span>}
      {payload.map((p) => (
        <span key={p.name} className="dash-tooltip-row">
          <span className="dash-tooltip-dot" style={{ background: p.color }} />
          <span className="dash-tooltip-name">{p.name}</span>
          <span className="dash-tooltip-value">
            {formatValue ? formatValue(p.value) : numberFmt.format(p.value)}
            {unit ? ` ${unit}` : ''}
          </span>
        </span>
      ))}
    </div>
  );
}

function Panel({
  title,
  hint,
  wide,
  children,
}: {
  title: string;
  hint?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`dash-panel ${wide ? 'dash-panel-wide' : ''}`.trim()}>
      <header className="dash-panel-head">
        <h3>{title}</h3>
        {hint && <span className="dash-panel-hint">{hint}</span>}
      </header>
      <div className="dash-panel-body">{children}</div>
    </section>
  );
}

function Kpi({
  value,
  label,
  accent,
}: {
  value: string;
  label: string;
  accent: string;
}) {
  return (
    <div className="dash-kpi">
      <span className="dash-kpi-bar" style={{ background: accent }} />
      <span className="dash-kpi-value">{value}</span>
      <span className="dash-kpi-label">{label}</span>
    </div>
  );
}

export function FeatureDashboard({
  featureId,
  featureName,
}: {
  featureId: string;
  featureName: string;
}) {
  const api = useApi();
  const { data, loading, error } = useAsync<FeatureUsage>(
    () => api.getFeatureUsage(featureId),
    [featureId],
  );

  return (
    <div className="dashboard">
      <header className="dash-header">
        <h2 className="dash-title">{featureName}</h2>
        <p className="dash-subtitle">Usage, history &amp; AIC analytics</p>
      </header>

      <ErrorText error={error} />
      {loading && <EmptyState message="Loading analytics…" />}

      {data && data.totals.sessions === 0 && (
        <div className="dash-empty">
          <EmptyState message="No usage recorded for this feature yet. Run a session to see analytics." />
        </div>
      )}

      {data && data.totals.sessions > 0 && <Charts data={data} />}
    </div>
  );
}

function Charts({ data }: { data: FeatureUsage }) {
  const { totals, byDay, byModel, bySession, timing } = data;
  const totalAic = nanoAiuToAic(totals.nanoAiu);

  const dayData = useMemo(
    () =>
      byDay.map((d) => ({
        day: d.day.slice(5),
        aic: nanoAiuToAic(d.nanoAiu),
        input: d.inputTokens,
        output: d.outputTokens,
      })),
    [byDay],
  );

  const modelData = useMemo(
    () =>
      byModel
        .map((m) => ({ name: m.model || 'unknown', aic: nanoAiuToAic(m.nanoAiu) }))
        .sort((a, b) => b.aic - a.aic),
    [byModel],
  );

  const sessionData = useMemo(
    () =>
      bySession
        .map((s) => ({
          name: shortId(s.sessionId),
          aic: nanoAiuToAic(s.nanoAiu),
        }))
        .sort((a, b) => b.aic - a.aic)
        .slice(0, 8),
    [bySession],
  );

  const timeData = useMemo(
    () =>
      bySession
        .map((s, i) => ({
          name: `#${i + 1}`,
          ms: s.activeMs,
        }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 8),
    [bySession],
  );

  return (
    <>
      <div className="dash-kpis">
        <Kpi value={totalAic.toFixed(2)} label="AIC used" accent={AIC_COLOR} />
        <Kpi
          value={numberFmt.format(totals.inputTokens + totals.outputTokens)}
          label="Total tokens"
          accent={TOKEN_IN}
        />
        <Kpi value={String(totals.sessions)} label="Sessions" accent={PALETTE[2]} />
        <Kpi
          value={formatDuration(timing.totalActiveMs)}
          label="Time spent"
          accent={TIME_COLOR}
        />
      </div>

      <div className="dash-grid">
        <Panel title="AIC over time" hint={`${totalAic.toFixed(2)} total`} wide>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={dayData} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
              <defs>
                <linearGradient id="aicFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={AIC_COLOR} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={AIC_COLOR} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="day"
                stroke="var(--text-faint)"
                tickLine={false}
                axisLine={false}
                fontSize={11}
              />
              <YAxis
                stroke="var(--text-faint)"
                tickLine={false}
                axisLine={false}
                fontSize={11}
                width={40}
              />
              <Tooltip
                content={<ChartTooltip unit="AIC" />}
                cursor={{ stroke: 'var(--border)' }}
              />
              <Area
                type="monotone"
                dataKey="aic"
                name="AIC"
                stroke={AIC_COLOR}
                strokeWidth={2}
                fill="url(#aicFill)"
                animationDuration={600}
              />
            </AreaChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="AIC by model">
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={modelData}
                dataKey="aic"
                nameKey="name"
                innerRadius={48}
                outerRadius={78}
                paddingAngle={2}
                stroke="none"
                animationDuration={600}
              >
                {modelData.map((m, i) => (
                  <Cell key={m.name} fill={color(i)} />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip unit="AIC" />} />
            </PieChart>
          </ResponsiveContainer>
          <ul className="dash-legend">
            {modelData.map((m, i) => (
              <li key={m.name}>
                <span className="dash-legend-dot" style={{ background: color(i) }} />
                <span className="dash-legend-label">{m.name}</span>
                <span className="dash-legend-value">{m.aic.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Tokens over time" hint="input vs output" wide>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dayData} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
              <XAxis
                dataKey="day"
                stroke="var(--text-faint)"
                tickLine={false}
                axisLine={false}
                fontSize={11}
              />
              <YAxis
                stroke="var(--text-faint)"
                tickLine={false}
                axisLine={false}
                fontSize={11}
                width={40}
              />
              <Tooltip
                content={<ChartTooltip unit="tokens" />}
                cursor={{ fill: 'var(--item-hover)' }}
              />
              <Bar
                dataKey="input"
                name="input"
                fill={TOKEN_IN}
                radius={[3, 3, 0, 0]}
                animationDuration={600}
              />
              <Bar
                dataKey="output"
                name="output"
                fill={TOKEN_OUT}
                radius={[3, 3, 0, 0]}
                animationDuration={600}
              />
            </BarChart>
          </ResponsiveContainer>
          <ul className="dash-legend dash-legend-row">
            <li>
              <span className="dash-legend-dot" style={{ background: TOKEN_IN }} />
              <span className="dash-legend-label">input</span>
            </li>
            <li>
              <span className="dash-legend-dot" style={{ background: TOKEN_OUT }} />
              <span className="dash-legend-label">output</span>
            </li>
          </ul>
        </Panel>

        <Panel title="AIC by session">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={sessionData}
              layout="vertical"
              margin={{ top: 4, right: 12, bottom: 4, left: 8 }}
            >
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="name"
                stroke="var(--text-faint)"
                tickLine={false}
                axisLine={false}
                fontSize={11}
                width={64}
              />
              <Tooltip
                content={<ChartTooltip unit="AIC" />}
                cursor={{ fill: 'var(--item-hover)' }}
              />
              <Bar
                dataKey="aic"
                name="AIC"
                radius={[0, 4, 4, 0]}
                animationDuration={600}
              >
                {sessionData.map((s, i) => (
                  <Cell key={s.name} fill={color(i)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Time by session" hint={`${formatDuration(timing.totalActiveMs)} total`}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
                data={timeData}
                layout="vertical"
                margin={{ top: 4, right: 12, bottom: 4, left: 8 }}
            >
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="name"
                  stroke="var(--text-faint)"
                  tickLine={false}
                  axisLine={false}
                  fontSize={11}
                  width={64}
                />
                <Tooltip
                  content={<ChartTooltip formatValue={formatDuration} />}
                  cursor={{ fill: 'var(--item-hover)' }}
                />
                <Bar
                  dataKey="ms"
                  name="active"
                  fill={TIME_COLOR}
                  radius={[0, 4, 4, 0]}
                  animationDuration={600}
                />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>
    </>
  );
}
