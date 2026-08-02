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
import { formatCompactNumber, formatDuration, nanoAiuToAic } from '../../lib/format.js';
import { sessionDisplayName } from '../../lib/session-names.js';
import type { FeatureUsage, PrReview, Session } from '../../lib/types.js';
import { EmptyState, ErrorText } from '../../components/ui.js';
import { Loader } from '../../components/loading.js';
import {
  ActivityIcon,
  OverviewIcon,
  UsageIcon,
} from '../../components/icons.js';
import { FeatureWorkSummaryPanel } from './work-summary.js';
import { PrReviewPanel } from './pr-review-panel.js';
import { SkillTagger } from '../skills/skill-tagger.js';

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

export function FeatureDashboard({
  featureId,
  featureName,
  featureDescription,
  prReview,
}: {
  featureId: string;
  featureName: string;
  featureDescription?: string;
  prReview?: PrReview;
}) {
  const api = useApi();
  const { data, loading, error } = useAsync<FeatureUsage>(
    () => api.getFeatureUsage(featureId),
    [featureId],
  );

  const description = featureDescription?.trim();

  return (
    <div className="dashboard">
      <header className="dash-header">
        <h2 className="dash-title">{featureName}</h2>
        <p className="dash-description">{description || 'No description'}</p>
      </header>

      <ErrorText error={error} />
      {loading && <Loader label="Loading analytics" />}

      <PrReviewPanel featureId={featureId} liveReview={prReview} />

      <section className="dash-skills">
        <SkillTagger
          scope="feature"
          targetId={featureId}
          label="Feature skills"
        />
      </section>

      {data && data.totals.sessions === 0 && (
        <div className="dash-empty">
          <EmptyState message="No usage recorded for this feature yet. Run a session to see analytics." />
        </div>
      )}

      {data && data.totals.sessions > 0 && (
        <Charts data={data} featureId={featureId} />
      )}

      <FeatureWorkSummaryPanel featureId={featureId} />
    </div>
  );
}

function Charts({ data, featureId }: { data: FeatureUsage; featureId: string }) {
  const api = useApi();
  const { totals, byDay, byModel, bySession, timing } = data;
  const totalAic = nanoAiuToAic(totals.nanoAiu);

  // Resolve human session labels (persisted name or "Session #N" in creation
  // order) so charts never show cryptic truncated ids.
  const { data: sessions } = useAsync<Session[]>(
    () => api.listSessions(featureId),
    [featureId],
  );
  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    (sessions ?? []).forEach((s, i) => {
      map.set(s.id, sessionDisplayName(s.name, i + 1));
    });
    return map;
  }, [sessions]);
  const labelFor = (sessionId: string, fallbackOrdinal: number): string =>
    nameById.get(sessionId) ?? sessionDisplayName(null, fallbackOrdinal);

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

  const sessionRows = useMemo(() => {
    const rows = bySession.map((s, i) => ({
      id: s.sessionId,
      name: labelFor(s.sessionId, i + 1),
      aic: nanoAiuToAic(s.nanoAiu),
      tokens: s.inputTokens + s.outputTokens,
      ms: s.activeMs,
    }));
    const maxAic = Math.max(1e-9, ...rows.map((r) => r.aic));
    return rows
      .map((r) => ({ ...r, aicPct: Math.round((r.aic / maxAic) * 100) }))
      .sort((a, b) => b.aic - a.aic);
  }, [bySession, nameById]);

  return (
    <>
      <Section icon={<OverviewIcon size={15} />} title="Overview">
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
      </Section>

      <Section
        icon={<UsageIcon size={15} />}
        title="Usage & cost"
        hint={`${totalAic.toFixed(2)} AIC total`}
      >
        <div className="dash-grid">
          <Panel title="AIC over time" hint={`${totalAic.toFixed(2)} total`}>
            <ResponsiveContainer width="100%" height={132}>
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
            <div className="dash-donut">
              <ResponsiveContainer width="100%" height={132}>
                <PieChart>
                  <Pie
                    data={modelData}
                    dataKey="aic"
                    nameKey="name"
                    innerRadius={38}
                    outerRadius={60}
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
            </div>
          </Panel>

          <Panel title="Tokens over time" hint="input vs output" wide>
            <ResponsiveContainer width="100%" height={132}>
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
        </div>
      </Section>

      <Section
        icon={<ActivityIcon size={15} />}
        title="Per-session activity"
        hint={`${sessionRows.length} sessions · ${formatDuration(timing.totalActiveMs)} active`}
      >
        <div className="dash-table" role="table" aria-label="Per-session activity">
          <div className="dash-table-head" role="row">
            <span role="columnheader">Session</span>
            <span role="columnheader" className="dash-num">AIC</span>
            <span role="columnheader" className="dash-num">Tokens</span>
            <span role="columnheader" className="dash-num">Time</span>
          </div>
          {sessionRows.map((s, i) => (
            <div className="dash-table-row" role="row" key={s.id}>
              <span className="dash-cell-name" role="cell" title={s.name}>
                <span
                  className="dash-cell-swatch"
                  style={{ background: color(i) }}
                  aria-hidden="true"
                />
                {s.name}
              </span>
              <span className="dash-cell-aic dash-num" role="cell">
                <span className="dash-bar-track" aria-hidden="true">
                  <span
                    className="dash-bar-fill"
                    style={{ width: `${s.aicPct}%`, background: color(i) }}
                  />
                </span>
                <span className="dash-cell-value">{s.aic.toFixed(2)}</span>
              </span>
              <span className="dash-num" role="cell">
                {formatCompactNumber(s.tokens)}
              </span>
              <span className="dash-num" role="cell">
                {formatDuration(s.ms)}
              </span>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
