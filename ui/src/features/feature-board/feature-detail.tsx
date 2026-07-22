import { useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { LiveState } from '../../lib/stream.js';
import type { Feature } from '../../lib/types.js';
import { Button, Card } from '../../components/ui.js';
import { SessionPanel } from '../session-panel/session-panel.js';
import { UsageDashboard } from '../usage-dashboard/usage-dashboard.js';
import { FeatureSummaryView } from '../feature-summary/feature-summary.js';

type Tab = 'sessions' | 'usage' | 'summary';

export function FeatureDetail({
  feature,
  live,
  onBack,
}: {
  feature: Feature;
  live: LiveState;
  onBack: () => void;
}) {
  const api = useApi();
  const [tab, setTab] = useState<Tab>('sessions');
  const usage = useAsync(() => api.getFeatureUsage(feature.id), [feature.id]);

  return (
    <div className="grid" style={{ gap: 'var(--space-5)' }}>
      <div className="page-header">
        <div>
          <Button variant="ghost" onClick={onBack}>
            ← Features
          </Button>
          <h1 className="page-title" style={{ marginTop: 'var(--space-3)' }}>
            {feature.name}
          </h1>
          <p className="page-subtitle">
            {feature.description || 'No description'}
          </p>
        </div>
        <div className="row">
          <Button
            variant={tab === 'sessions' ? 'primary' : 'ghost'}
            onClick={() => setTab('sessions')}
          >
            Sessions
          </Button>
          <Button
            variant={tab === 'usage' ? 'primary' : 'ghost'}
            onClick={() => {
              setTab('usage');
              usage.reload();
            }}
          >
            Usage
          </Button>
          <Button
            variant={tab === 'summary' ? 'primary' : 'ghost'}
            onClick={() => setTab('summary')}
          >
            Summary
          </Button>
        </div>
      </div>

      {tab === 'sessions' && (
        <SessionPanel featureId={feature.id} live={live} />
      )}
      {tab === 'usage' &&
        (usage.data ? (
          <UsageDashboard usage={usage.data} />
        ) : (
          <Card>Loading usage…</Card>
        ))}
      {tab === 'summary' && <FeatureSummaryView featureId={feature.id} />}
    </div>
  );
}
