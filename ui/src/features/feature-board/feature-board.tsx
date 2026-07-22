import { useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { formatDateTime } from '../../lib/format.js';
import type { Feature } from '../../lib/types.js';
import { Button, Card, EmptyState, ErrorText } from '../../components/ui.js';

export function FeatureBoard({
  onOpenFeature,
}: {
  onOpenFeature: (feature: Feature) => void;
}) {
  const api = useApi();
  const { data, loading, error, reload } = useAsync(
    () => api.listFeatures(),
    [],
  );
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function createFeature() {
    if (!name.trim()) {
      setFormError('Name is required');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await api.createFeature({ name: name.trim(), description });
      setName('');
      setDescription('');
      reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid grid-2">
      <Card>
        <h2 className="page-title">Features</h2>
        <p className="page-subtitle">
          Organize AI-assisted work by feature and track every session's cost.
        </p>
        <div style={{ marginTop: 'var(--space-4)' }}>
          {loading && <EmptyState message="Loading features…" />}
          <ErrorText error={error} />
          {data && data.length === 0 && (
            <EmptyState message="No features yet. Create your first one." />
          )}
          <div className="list">
            {data?.map((feature) => (
              <button
                key={feature.id}
                type="button"
                className="list-row"
                onClick={() => onOpenFeature(feature)}
              >
                <span>
                  <strong>{feature.name}</strong>
                  <br />
                  <span className="muted">
                    {feature.description || 'No description'}
                  </span>
                </span>
                <span className="muted">{formatDateTime(feature.createdAt)}</span>
              </button>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="page-title">New feature</h2>
        <div className="field" style={{ marginTop: 'var(--space-4)' }}>
          <label htmlFor="feature-name">Name</label>
          <input
            id="feature-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Checkout redesign"
          />
        </div>
        <div className="field">
          <label htmlFor="feature-desc">Description</label>
          <textarea
            id="feature-desc"
            className="textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What are you building?"
          />
        </div>
        <ErrorText error={formError} />
        <Button onClick={createFeature} disabled={submitting}>
          {submitting ? 'Creating…' : 'Create feature'}
        </Button>
      </Card>
    </div>
  );
}
