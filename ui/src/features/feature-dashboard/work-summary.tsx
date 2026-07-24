import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { formatDateTime, statusLabel } from '../../lib/format.js';
import { defaultSessionLabel } from '../../lib/session-names.js';
import type {
  FeatureWorkSummary,
  SessionWorkSummary,
} from '../../lib/types.js';
import { EmptyState, ErrorText, StatusBadge } from '../../components/ui.js';
import {
  ChevronIcon,
  RefreshIcon,
  SummaryIcon,
} from '../../components/icons.js';

export function workSummarySessionTitle(
  session: SessionWorkSummary,
  index: number,
): string {
  return session.prompt.trim() || defaultSessionLabel(index + 1);
}

function SessionCard({
  session,
  index,
}: {
  session: SessionWorkSummary;
  index: number;
}) {
  const [open, setOpen] = useState(true);
  const title = workSummarySessionTitle(session, index);
  const tooltip = session.prompt.trim() || session.summary?.trim() || title;

  return (
    <article className="work-session">
      <button
        type="button"
        className="work-session-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="work-caret" aria-hidden="true">
          <ChevronIcon open={open} size={14} />
        </span>
        <span className="work-session-title" title={tooltip}>
          {title}
        </span>
        <StatusBadge status={statusLabel(session.status)} />
        <span className="work-session-date">
          {formatDateTime(session.createdAt)}
        </span>
      </button>

      {open && (
        <div className="work-session-body">
          {session.summary && (
            <p className="work-session-summary" title={session.summary}>
              {session.summary}
            </p>
          )}

          {session.checkpoints.length > 0 ? (
            <ol className="work-checkpoints">
              {session.checkpoints.map((cp) => (
                <li key={cp.number} className="work-checkpoint">
                  <div className="work-checkpoint-head">
                    <span className="work-checkpoint-title">{cp.title}</span>
                    <span className="work-checkpoint-date">
                      {formatDateTime(cp.createdAt)}
                    </span>
                  </div>
                  {!session.summary && cp.overview && (
                    <p className="work-checkpoint-overview" title={cp.overview}>
                      {cp.overview}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            !session.summary && (
              <p className="muted work-session-empty">
                No checkpoints recorded yet for this session.
              </p>
            )
          )}
        </div>
      )}
    </article>
  );
}

export function FeatureWorkSummaryPanel({ featureId }: { featureId: string }) {
  const api = useApi();
  const { data, loading, error, reload } = useAsync<FeatureWorkSummary>(
    () => api.getFeatureWorkSummary(featureId),
    [featureId],
  );
  const autoRefreshMs = 10_000;

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!loading) {
        reload();
      }
    }, autoRefreshMs);
    return () => window.clearInterval(timer);
  }, [autoRefreshMs, loading, reload]);

  return (
    <section className="work-summary">
      <header className="work-summary-head">
        <div className="work-summary-title">
          <h3>
            <SummaryIcon size={15} /> Work summary
          </h3>
          <span className="work-summary-hint">
            What the assistant did across this feature&apos;s sessions
          </span>
          <span className="work-summary-hint">Auto-refreshes every 10s</span>
        </div>
        <button
          type="button"
          className="work-summary-refresh"
          onClick={reload}
          disabled={loading}
          aria-label="Refresh work summary"
          title="Refresh work summary"
        >
          <RefreshIcon className={loading ? 'is-spinning' : ''} />
          <span className="sr-only">{loading ? 'Refreshing work summary' : 'Refresh work summary'}</span>
        </button>
      </header>

      <ErrorText error={error} />
      {loading && !data && <EmptyState message="Loading work summary…" />}

      {data && data.sessions.length === 0 && (
        <EmptyState message="No sessions yet. Start a session to build this feature's history." />
      )}

      {data && data.sessions.length > 0 && (
        <div className="work-sessions">
          {data.sessions.map((session, index) => (
            <SessionCard key={session.sessionId} session={session} index={index} />
          ))}
        </div>
      )}
    </section>
  );
}
