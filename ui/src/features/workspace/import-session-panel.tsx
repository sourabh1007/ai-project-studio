import { useMemo, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { ImportableSession, Session } from '../../lib/types.js';
import { Button, EmptyState, ErrorText } from '../../components/ui.js';
import { formatDateTime } from '../../lib/format.js';

/**
 * Inline panel that lists past provider sessions (from each provider's own
 * store, e.g. the Agency CLI) and imports the chosen one into a Feature.
 * Provider-agnostic: it renders whatever the backend aggregates across
 * providers, so new providers appear here automatically.
 */
export function ImportSessionPanel({
  featureId,
  onImported,
  onCancel,
}: {
  featureId: string;
  onImported: (session: Session) => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const importable = useAsync(() => api.listImportableSessions(), []);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const all = importable.data ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return all;
    }
    return all.filter((s) =>
      [s.title, s.repository ?? '', s.branch ?? '', s.model ?? '', s.provider]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [importable.data, query]);

  async function importOne(session: ImportableSession) {
    setBusyId(session.externalId);
    setError(null);
    try {
      const imported = await api.importSession(featureId, {
        provider: session.provider,
        externalId: session.externalId,
      });
      onImported(imported);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="import-panel glass">
      <div className="import-panel-head">
        <span className="import-panel-title">Import a session</span>
        <input
          className="import-panel-search"
          placeholder="Filter by title, repo, model…"
          aria-label="Filter importable sessions"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <ErrorText error={importable.error ?? error} />
      {importable.loading && <EmptyState message="Loading sessions…" />}
      {!importable.loading && rows.length === 0 && (
        <EmptyState message="No importable sessions found." />
      )}
      <ul className="import-list" role="list">
        {rows.map((session) => {
          const meta = [
            session.repository
              ? session.branch
                ? `${session.repository}·${session.branch}`
                : session.repository
              : null,
            session.model,
            `${session.messageCount} msg`,
            formatDateTime(session.updatedAt),
          ].filter(Boolean) as string[];
          return (
            <li key={`${session.provider}:${session.externalId}`} className="import-row">
              <button
                type="button"
                className="import-row-main"
                title={`Import “${session.title}”`}
                disabled={busyId !== null}
                onClick={() => void importOne(session)}
              >
                <span className="import-row-title">{session.title}</span>
                <span className="import-row-meta">
                  <span className="import-badge">{session.provider}</span>
                  {meta.map((m, i) => (
                    <span key={i} className="import-meta-item">
                      {m}
                    </span>
                  ))}
                </span>
              </button>
              {busyId === session.externalId && (
                <span className="import-row-status">Importing…</span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="row">
        <Button variant="ghost" onClick={onCancel}>
          Close
        </Button>
      </div>
    </div>
  );
}
