import { useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { AgentCatalogItem } from '../../lib/types.js';
import { Card } from '../../components/ui.js';
import { ErrorState } from '../../components/error-state.js';
import { Loader } from '../../components/loading.js';
import { AgentIcon } from '../../agent-host/agent-icon.js';
import { PromptFieldEditor } from '../settings/prompts-commands-section.js';

function formatCredits(value: number | null): string {
  return value == null ? '—' : value.toFixed(2);
}

/** Detail page for one agent: its stats and editable prompts/settings. */
function AgentDetail({
  item,
  onBack,
}: {
  item: AgentCatalogItem;
  onBack: () => void;
}) {
  const api = useApi();
  const { data, loading, error, cause, reload } = useAsync(
    () => api.getConfig(),
    [],
  );
  const { manifest, usage } = item;

  return (
    <div className="agents-detail">
      <button type="button" className="agents-back" onClick={onBack}>
        ← All agents
      </button>
      <header className="agents-detail-head">
        <span className="agents-detail-icon" aria-hidden="true">
          <AgentIcon icon={manifest.icon} size={24} />
        </span>
        <div>
          <h2 className="agents-detail-title">{manifest.title}</h2>
          <p className="muted">{manifest.description}</p>
        </div>
      </header>

      <div className="agents-detail-stats">
        <div className="agents-stat">
          <span className="muted">Avg credits / run</span>
          <strong>{formatCredits(usage.averageCredits)}</strong>
        </div>
        <div className="agents-stat">
          <span className="muted">Recorded runs</span>
          <strong>{usage.runs}</strong>
        </div>
        <div className="agents-stat">
          <span className="muted">Attached to</span>
          <strong>{item.attachmentCount}</strong>
        </div>
        <div className="agents-stat">
          <span className="muted">Prerequisite</span>
          <strong>{manifest.prerequisiteLabel}</strong>
        </div>
        <div className="agents-stat">
          <span className="muted">Multiple per feature</span>
          <strong>{manifest.allowMultiplePerFeature ? 'Yes' : 'No'}</strong>
        </div>
      </div>

      <h3 className="agents-detail-subhead">Prompts &amp; settings</h3>
      {loading && <Loader label="Loading settings…" />}
      {error && <ErrorState error={cause ?? error} onRetry={reload} />}
      {data &&
        (manifest.promptFields.length === 0 ? (
          <p className="muted">This agent exposes no editable prompts.</p>
        ) : (
          <Card className="agents-prompts">
            {manifest.promptFields.map((field) => (
              <PromptFieldEditor
                key={`${field.namespace}.${field.key}`}
                field={field}
                data={data}
                onSaved={reload}
              />
            ))}
          </Card>
        ))}
    </div>
  );
}

/**
 * The Agents activity-bar view: a catalog of every installed agent with its
 * average credit cost and reach, and a detail page to edit each agent's
 * prompts/settings. Peer of the Skills/Usage views.
 */
export function AgentsView() {
  const api = useApi();
  const { data, loading, error, cause, reload } = useAsync(
    () => api.listAgents(),
    [],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (loading) {
    return <Loader label="Loading agents…" />;
  }
  if (error) {
    return <ErrorState error={cause ?? error} onRetry={reload} />;
  }

  const items = data ?? [];
  const selected =
    items.find((item) => item.manifest.id === selectedId) ?? null;

  if (selected) {
    return <AgentDetail item={selected} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div className="agents-view">
      <header className="agents-view-head">
        <h1 className="agents-view-title">Agents</h1>
        <p className="muted">
          Attachable analysis surfaces you can add to any eligible feature.
        </p>
      </header>
      {items.length === 0 ? (
        <p className="muted">No agents installed.</p>
      ) : (
        <div className="agents-grid">
          {items.map((item) => (
            <button
              key={item.manifest.id}
              type="button"
              className="agents-card"
              onClick={() => setSelectedId(item.manifest.id)}
            >
              <span className="agents-card-icon" aria-hidden="true">
                <AgentIcon icon={item.manifest.icon} size={20} />
              </span>
              <span className="agents-card-body">
                <span className="agents-card-title">{item.manifest.title}</span>
                <span className="agents-card-desc">
                  {item.manifest.description}
                </span>
                <span className="agents-card-meta">
                  <span>{formatCredits(item.usage.averageCredits)} AIC / run</span>
                  <span>·</span>
                  <span>{item.attachmentCount} attached</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
