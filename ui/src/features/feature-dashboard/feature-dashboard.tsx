import { useMemo, useState } from 'react';
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
import {
  buildUsageTree,
  type FeatureUsageTreeNode,
  type GroupUsageTreeNode,
  type UsageTreeNode,
} from '../../lib/usage-tree.js';
import type {
  ContextStatusPhase,
  FeatureUsage,
  Session,
} from '../../lib/types.js';
import { EmptyState, ErrorText } from '../../components/ui.js';
import { UsageBreakdownModal } from '../../components/usage-breakdown.js';
import { Loader } from '../../components/loading.js';
import {
  ActivityIcon,
  OverviewIcon,
  UsageIcon,
} from '../../components/icons.js';
import { FeatureWorkSummaryPanel } from './work-summary.js';
import { SkillTagger } from '../skills/skill-tagger.js';
import { SharedContextPanel } from '../shared-context/shared-context-panel.js';

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
  onClick,
}: {
  value: string;
  label: string;
  accent: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="dash-kpi-bar" style={{ background: accent }} />
      <span className="dash-kpi-value">{value}</span>
      <span className="dash-kpi-label">{label}</span>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className="dash-kpi dash-kpi-button"
        title={`View how each credit and token was used (${label})`}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }
  return <div className="dash-kpi">{content}</div>;
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

function nodeTokens(node: UsageTreeNode): number {
  return (
    node.totals.inputTokens +
    node.totals.outputTokens +
    node.totals.reasoningOutputTokens
  );
}

function originLabel(origin: 'ide' | 'user'): string {
  if (origin === 'ide') {
    return 'IDE metasession';
  }
  return 'User session';
}

function UsageTreeRows({
  node,
  depth,
  maxAic,
  colorIndex,
  labelFor,
}: {
  node: FeatureUsageTreeNode | GroupUsageTreeNode;
  depth: number;
  maxAic: number;
  colorIndex: (id: string) => number;
  labelFor: (sessionId: string) => string;
}) {
  return (
    <>
      {node.children.map((child) => {
        const aic = nanoAiuToAic(child.totals.nanoAiu);
        const pct = Math.round((aic / maxAic) * 100);
        const swatch = color(colorIndex(child.id));
        const isSession = child.type === 'session';
        const name = isSession ? labelFor(child.id) : child.name;
        return (
          <div key={`${child.type}-${child.id}`} className="dash-tree-branch">
            <div
              className={`dash-table-row dash-tree-row dash-tree-${child.type}`}
              role="row"
              style={{ '--usage-depth': depth } as React.CSSProperties}
            >
              <span className="dash-cell-name dash-tree-name" role="cell" title={name}>
                <span
                  className="dash-cell-swatch"
                  style={{ background: swatch }}
                  aria-hidden="true"
                />
                <span className="dash-tree-label">{name}</span>
                {child.type === 'group' && child.kind === 'pr' && (
                  <span className="dash-pr-badge">PR</span>
                )}
                {isSession && (
                  <span className={`dash-origin-tag dash-origin-${child.origin}`}>
                    {originLabel(child.origin)}
                  </span>
                )}
              </span>
              <span className="dash-cell-aic dash-num" role="cell">
                <span className="dash-bar-track" aria-hidden="true">
                  <span
                    className="dash-bar-fill"
                    style={{ width: `${pct}%`, background: swatch }}
                  />
                </span>
                <span className="dash-cell-value">{aic.toFixed(2)}</span>
              </span>
              <span className="dash-num" role="cell">
                {formatCompactNumber(nodeTokens(child))}
              </span>
              <span className="dash-num" role="cell">
                {formatDuration(child.totals.activeMs)}
              </span>
            </div>
            {child.type !== 'session' && (
              <UsageTreeRows
                node={child}
                depth={depth + 1}
                maxAic={maxAic}
                colorIndex={colorIndex}
                labelFor={labelFor}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export function FeatureDashboard({
  featureId,
  featureName,
  featureDescription,
  contextPhase,
}: {
  featureId: string;
  featureName: string;
  featureDescription?: string;
  contextPhase?: ContextStatusPhase;
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
        <Charts data={data} featureId={featureId} featureName={featureName} />
      )}

      <section className="dash-shared-context">
        <SharedContextPanel
          scope="feature"
          scopeId={featureId}
          title="Shared context"
          hint="Durable knowledge injected into every session for this feature. Auto-curated after each session; edit freely."
          livePhase={contextPhase}
        />
      </section>

      <FeatureWorkSummaryPanel featureId={featureId} />
    </div>
  );
}

function Charts({
  data,
  featureId,
  featureName,
}: {
  data: FeatureUsage;
  featureId: string;
  featureName: string;
}) {
  const api = useApi();
  const [viewingUsage, setViewingUsage] = useState(false);
  const { totals, groups, byDay, byModel, bySession, timing } = data;
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
  const ordinalById = useMemo(() => {
    const map = new Map<string, number>();
    bySession.forEach((s, i) => {
      map.set(s.sessionId, i + 1);
    });
    return map;
  }, [bySession]);
  const labelFor = (sessionId: string): string => {
    const ordinal = ordinalById.get(sessionId) ?? 1;
    return nameById.get(sessionId) ?? sessionDisplayName(null, ordinal);
  };

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

  const usageTree = useMemo(
    () => buildUsageTree(groups, bySession),
    [groups, bySession],
  );
  const maxAic = useMemo(
    () => Math.max(1e-9, ...bySession.map((s) => nanoAiuToAic(s.nanoAiu))),
    [bySession],
  );
  const colorIndex = (id: string): number => {
    const index = bySession.findIndex((s) => s.sessionId === id);
    if (index >= 0) {
      return index;
    }
    const groupIndex = groups.findIndex((g) => g.id === id);
    if (groupIndex >= 0) {
      return groupIndex + bySession.length;
    }
    return 0;
  };

  return (
    <>
      <Section icon={<OverviewIcon size={15} />} title="Overview">
        <div className="dash-kpis">
          <Kpi
            value={totalAic.toFixed(2)}
            label="AIC used"
            accent={AIC_COLOR}
            onClick={() => setViewingUsage(true)}
          />
          <Kpi
            value={numberFmt.format(totals.inputTokens + totals.outputTokens)}
            label="Total tokens"
            accent={TOKEN_IN}
            onClick={() => setViewingUsage(true)}
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
        title="Usage tree"
        hint={`${bySession.length} sessions · ${formatDuration(timing.totalActiveMs)} active`}
      >
      <div className="dash-table dash-usage-tree" role="table" aria-label="Nested usage activity">
          <div className="dash-table-head" role="row">
          <span role="columnheader">Feature / group / session</span>
            <span role="columnheader" className="dash-num">AIC</span>
            <span role="columnheader" className="dash-num">Tokens</span>
            <span role="columnheader" className="dash-num">Time</span>
          </div>
        <div className="dash-table-row dash-tree-row dash-tree-feature" role="row">
          <span className="dash-cell-name dash-tree-name" role="cell">
            <span
              className="dash-cell-swatch"
              style={{ background: AIC_COLOR }}
              aria-hidden="true"
            />
            <span className="dash-tree-label">{featureName}</span>
          </span>
          <span className="dash-cell-aic dash-num" role="cell">
            <span className="dash-bar-track" aria-hidden="true">
              <span
                className="dash-bar-fill"
                style={{ width: '100%', background: AIC_COLOR }}
              />
            </span>
            <span className="dash-cell-value">
              {nanoAiuToAic(usageTree.totals.nanoAiu).toFixed(2)}
              </span>
          </span>
          <span className="dash-num" role="cell">
            {formatCompactNumber(nodeTokens(usageTree))}
          </span>
          <span className="dash-num" role="cell">
            {formatDuration(usageTree.totals.activeMs)}
          </span>
        </div>
        <UsageTreeRows
          node={usageTree}
          depth={1}
          maxAic={maxAic}
          colorIndex={colorIndex}
          labelFor={labelFor}
        />
      </div>
      </Section>

      {viewingUsage && (
        <UsageBreakdownModal
          scope={{ kind: 'feature', id: featureId, label: featureName }}
          onClose={() => setViewingUsage(false)}
        />
      )}
    </>
  );
}
