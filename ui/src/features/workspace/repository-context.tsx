import { useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ErrorText, Modal } from '../../components/ui.js';
import { RefreshIcon } from '../../components/icons.js';
import type {
  Repository,
  RepositoryContext,
  RepositoryContextStatus,
  RepositoryContextStep,
  RepositoryContextStepStatus,
} from '../../lib/types.js';

const STATUS_LABELS: Record<RepositoryContextStatus, string> = {
  pending: 'Pending',
  generating: 'Analyzing',
  ready: 'Ready',
  stale: 'Refreshing',
  failed: 'Failed',
};

const STEP_STATUS_LABELS: Record<RepositoryContextStepStatus, string> = {
  pending: 'Waiting',
  running: 'Working',
  ok: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
};

const STEP_GLYPHS: Record<RepositoryContextStepStatus, string> = {
  pending: '○',
  running: '',
  ok: '✓',
  failed: '✕',
  skipped: '–',
};

export function repositoryContextBlockReason(
  context: RepositoryContext | null | undefined,
): string | null {
  if (context?.status === 'ready') {
    return null;
  }
  if (!context || context.status === 'pending') {
    return 'Repository context is pending analysis.';
  }
  if (context.status === 'generating') {
    return 'Repository context is being analyzed.';
  }
  if (context.status === 'stale') {
    return 'Repository context is refreshing after the checkout changed.';
  }
  return context.failure?.message
    ? `Repository context failed: ${context.failure.message}`
    : 'Repository context generation failed.';
}

export function RepositoryContextBadge({
  context,
  onClick,
}: {
  context: RepositoryContext | null | undefined;
  onClick: () => void;
}) {
  const status = context?.status ?? 'pending';
  const label = STATUS_LABELS[status];
  return (
    <button
      type="button"
      className={`repo-context-badge repo-context-${status}`}
      title={`Repository context: ${label}`}
      aria-label={`View repository context, status ${label}`}
      onClick={onClick}
    >
      {(status === 'pending' || status === 'generating' || status === 'stale') && (
        <span className="spinner repo-context-spinner" aria-hidden="true" />
      )}
      <span>{label}</span>
    </button>
  );
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Not generated';
}

function StepIndicator({ status }: { status: RepositoryContextStepStatus }) {
  if (status === 'running') {
    return <span className="spinner repo-step-spinner" aria-hidden="true" />;
  }
  return (
    <span className="repo-step-glyph" aria-hidden="true">
      {STEP_GLYPHS[status]}
    </span>
  );
}

export function RepositoryContextSteps({
  steps,
}: {
  steps: RepositoryContextStep[];
}) {
  if (steps.length === 0) {
    return null;
  }
  return (
    <ol className="repo-context-steps" aria-label="Context collection steps">
      {steps.map((step) => (
        <li
          key={step.key}
          className={`repo-context-step repo-step-${step.status}`}
        >
          <StepIndicator status={step.status} />
          <div className="repo-step-body">
            <span className="repo-step-label">{step.label}</span>
            {step.detail && (
              <span className="repo-step-detail">{step.detail}</span>
            )}
          </div>
          <span className="repo-step-status">
            {STEP_STATUS_LABELS[step.status]}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function RepositoryContextViewer({
  repo,
  context,
  onClose,
  onUpdated,
}: {
  repo: Repository;
  context: RepositoryContext;
  onClose: () => void;
  onUpdated: (context: RepositoryContext) => void;
}) {
  const api = useApi();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionLabel = context.status === 'failed' ? 'Retry' : 'Refresh';
  const working =
    context.status === 'pending' ||
    context.status === 'generating' ||
    context.status === 'stale';

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      onUpdated(await api.refreshRepositoryContext(repo.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Modal title={`Repository context · ${repo.name}`} onClose={onClose}>
      <div className="repo-context-viewer">
        <div className="repo-context-heading">
          <span className={`repo-context-state repo-context-${context.status}`}>
            {STATUS_LABELS[context.status]}
          </span>
          <span aria-live="polite">
            {repositoryContextBlockReason(context) ?? 'Ready for new sessions.'}
          </span>
        </div>

        <dl className="repo-context-meta">
          <div>
            <dt>Source revision</dt>
            <dd>{context.sourceRevision ?? 'Unknown'}</dd>
          </div>
          <div>
            <dt>Generated</dt>
            <dd>{formatTimestamp(context.timestamps.generatedAt)}</dd>
          </div>
          <div>
            <dt>Last updated</dt>
            <dd>{formatTimestamp(context.timestamps.updatedAt)}</dd>
          </div>
        </dl>

        {working && (
          <div className="repo-context-active" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span className="repo-context-active-text">
              Analyzing repository
              <span className="repo-context-dots" aria-hidden="true">
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>
            </span>
          </div>
        )}

        <RepositoryContextSteps steps={context.steps} />

        {context.failure && (
          <div className="repo-context-failure" role="alert">
            <strong>Latest attempt failed</strong>
            <span>{context.failure.message}</span>
            {context.content && <span>The last successful summary is retained below.</span>}
          </div>
        )}

        {context.content ? (
          <pre className="repo-context-content">{context.content}</pre>
        ) : (
          <p className="muted">
            Context will appear here when background analysis completes.
          </p>
        )}

        <ErrorText error={error} />
        <div className="row modal-actions">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void refresh()} disabled={refreshing}>
            <RefreshIcon size={13} /> {refreshing ? `${actionLabel}ing…` : actionLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
