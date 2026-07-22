import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCredits, formatTokens } from '../../lib/format.js';
import type { FeatureUsage } from '../../lib/types.js';
import { Card, EmptyState, Stat } from '../../components/ui.js';

const PIE_COLORS = ['#4f46e5', '#06b6d4', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444'];

export function UsageDashboard({ usage }: { usage: FeatureUsage }) {
  const hasData = usage.totals.sessions > 0;
  return (
    <div className="grid" style={{ gap: 'var(--space-5)' }}>
      <Card>
        <h2 className="page-title">Usage & credits</h2>
        <div className="grid grid-stats" style={{ marginTop: 'var(--space-4)' }}>
          <Stat label="Sessions" value={usage.totals.sessions} />
          <Stat label="Credits" value={formatCredits(usage.totals.credits)} />
          <Stat label="Input tokens" value={formatTokens(usage.totals.inputTokens)} />
          <Stat
            label="Output tokens"
            value={formatTokens(usage.totals.outputTokens)}
          />
        </div>
      </Card>

      {!hasData && (
        <Card>
          <EmptyState message="No usage captured yet. Run a session to see credits." />
        </Card>
      )}

      {hasData && (
        <div className="grid grid-2">
          <Card>
            <h3>Credits by model</h3>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={usage.byModel}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="model" stroke="var(--text-muted)" />
                <YAxis stroke="var(--text-muted)" />
                <Tooltip />
                <Bar dataKey="credits" fill="#4f46e5" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <Card>
            <h3>Credits by provider</h3>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={usage.byProvider}
                  dataKey="credits"
                  nameKey="provider"
                  outerRadius={90}
                  label
                >
                  {usage.byProvider.map((entry, index) => (
                    <Cell
                      key={entry.provider}
                      fill={PIE_COLORS[index % PIE_COLORS.length]}
                    />
                  ))}
                </Pie>
                <Legend />
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </Card>

          <Card className="grid-span">
            <h3>Credits over time</h3>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={usage.byDay}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" stroke="var(--text-muted)" />
                <YAxis stroke="var(--text-muted)" />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="credits"
                  stroke="#06b6d4"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </Card>
        </div>
      )}
    </div>
  );
}
