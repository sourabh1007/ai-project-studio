import { useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { formatDateTime } from '../../lib/format.js';
import type { FeatureSummary } from '../../lib/types.js';
import { Button, Card, EmptyState, ErrorText } from '../../components/ui.js';
import { Loader } from '../../components/loading.js';

export function FeatureSummaryView({ featureId }: { featureId: string }) {
  const api = useApi();
  const { data, loading, error, reload } = useAsync<FeatureSummary | null>(
    () => api.getSummary(featureId).catch(() => null),
    [featureId],
  );
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  async function generate() {
    setGenerating(true);
    setGenError(null);
    try {
      await api.generateSummary(featureId);
      reload();
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Card>
      <div className="page-header">
        <div>
          <h2 className="page-title">AI feature summary</h2>
          <p className="page-subtitle">
            Synthesized across this feature's sessions.
          </p>
        </div>
        <Button onClick={generate} disabled={generating}>
          {generating ? 'Summarizing…' : 'Generate summary'}
        </Button>
      </div>
      <ErrorText error={error ?? genError} />
      {loading && <Loader label="Loading summary" />}
      {!loading && !data && (
        <EmptyState message="No summary yet. Generate one from your sessions." />
      )}
      {data && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <p className="muted">Generated {formatDateTime(data.createdAt)}</p>
          <div className="terminal-log" style={{ background: 'var(--surface-strong)', color: 'var(--text)' }}>
            {data.content}
          </div>
        </div>
      )}
    </Card>
  );
}
