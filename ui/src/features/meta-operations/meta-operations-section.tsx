import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, StatusBadge } from '../../components/ui.js';
import { RefreshIcon } from '../../components/icons.js';
import type { MetaOperation, MetaOperationPage, MetaOperationSummary } from './meta-operation-types.js';

export interface MetaOperationsSectionProps {
  featureId?: string;
  sessionId?: string;
  automationId?: string;
}

function credits(operation: MetaOperationSummary | MetaOperation): string {
  if (operation.usage?.credits != null) return `${operation.usage.credits} credits`;
  return operation.usageState === 'unsupported' ? 'Usage unsupported' : 'Credits unknown';
}

type OpState = MetaOperation['state'];

/**
 * Maps a raw operation state to the app's canonical status tone (via a status
 * string {@link StatusBadge} understands) plus a plain-language caption. This
 * turns a wall of repeated "failed"/"interrupted" tokens into something a user
 * can actually read: a coloured badge and a sentence saying what it means.
 */
const STATE_META: Record<OpState, { badgeStatus: string; label: string; caption: string }> = {
  pending: { badgeStatus: 'pending', label: 'Pending', caption: 'Queued — has not started yet.' },
  running: { badgeStatus: 'running', label: 'Running', caption: 'In progress right now.' },
  completed: { badgeStatus: 'completed', label: 'Completed', caption: 'Finished and captured a durable result.' },
  interrupted: { badgeStatus: 'warning', label: 'Interrupted', caption: 'Stopped before finishing — some effects may already have happened.' },
  failed: { badgeStatus: 'failed', label: 'Failed', caption: 'Ended with an error before producing a result.' },
};

/** Human-friendly "time ago"; returns '' for missing or unparseable stamps. */
function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const abs = Math.abs(Date.now() - ms);
  const minute = 60_000, hour = 60 * minute, day = 24 * hour;
  if (abs < minute) return 'just now';
  if (abs < hour) return `${Math.round(abs / minute)}m ago`;
  if (abs < day) return `${Math.round(abs / hour)}h ago`;
  if (abs < 30 * day) return `${Math.round(abs / day)}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Elapsed wall-clock between start and finish; '' when either is unknown. */
function durationLabel(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt || !finishedAt) return '';
  const start = Date.parse(startedAt), end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '';
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60), remSec = seconds % 60;
  if (minutes < 60) return remSec ? `${minutes}m ${remSec}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60), remMin = minutes % 60;
  return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
}

/** The provider/metasession id that actually ran the operation, if known. */
function sessionInfo(operation: MetaOperationSummary): { label: string; id: string } | null {
  const id = operation.providerSessionId ?? operation.sessionId ?? operation.sessionIds[0] ?? null;
  if (!id) return null;
  return { label: operation.transport === 'warm-acp' ? 'Metasession' : 'Session', id };
}

/** Short, hoverable form of a long session/metasession UUID. */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/** Token counts when the provider reported them, else ''. */
function tokenLabel(operation: MetaOperationSummary): string {
  const input = operation.usage?.inputTokens, output = operation.usage?.outputTokens;
  if (input == null && output == null) return '';
  return `${input ?? 0} in / ${output ?? 0} out`;
}

/** Ordered, non-zero counts of the loaded operations by state. */
function stateCounts(items: MetaOperationSummary[]): Array<{ state: OpState; count: number }> {
  const order: OpState[] = ['running', 'pending', 'interrupted', 'failed', 'completed'];
  return order
    .map((state) => ({ state, count: items.filter((item) => item.state === state).length }))
    .filter((entry) => entry.count > 0);
}

export function MetaOperationsSection({ featureId, sessionId, automationId }: MetaOperationsSectionProps) {
  const api = useApi();
  const [page, setPage] = useState<MetaOperationPage>({ items: [], nextCursor: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [detail, setDetail] = useState<{ id: string; operation: MetaOperation | null; failed: boolean } | null>(null);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);

  const loadPage = useCallback(async (after: string | null) => {
    const generation = ++listGeneration.current;
    setLoading(true); setError(false);
    try {
      const result = await api.listMetaOperations({ featureId, sessionId, automationId, after });
      if (generation !== listGeneration.current) return;
      setPage((current) => ({ items: after === null ? result.items : [...current.items, ...result.items], nextCursor: result.nextCursor }));
    } catch {
      if (generation === listGeneration.current) setError(true);
    } finally {
      if (generation === listGeneration.current) setLoading(false);
    }
  }, [api, featureId, sessionId, automationId]);

  useEffect(() => {
    setPage({ items: [], nextCursor: null });
    setDetail(null); detailGeneration.current += 1;
    void loadPage(null);
    return () => { listGeneration.current += 1; detailGeneration.current += 1; };
  }, [loadPage]);

  const open = async (id: string) => {
    const generation = ++detailGeneration.current;
    setDetail({ id, operation: null, failed: false });
    try {
      const operation = await api.getMetaOperation(id);
      if (generation === detailGeneration.current) setDetail({ id, operation, failed: false });
    } catch {
      if (generation === detailGeneration.current) setDetail({ id, operation: null, failed: true });
    }
  };
  const close = () => { detailGeneration.current += 1; setDetail(null); };

  const counts = stateCounts(page.items);

  return (
    <section className="settings-section meta-ops" aria-label="Saved AI operations">
      <div className="meta-ops-head">
        <div className="meta-ops-heading">
          <h3 className="settings-section-title">Saved AI operations</h3>
          <p className="settings-section-sub">Durable results and interrupted work. Unknown usage is not zero cost.</p>
        </div>
        <Button variant="ghost" className="meta-ops-refresh" disabled={loading} onClick={() => void loadPage(null)}>
          <RefreshIcon size={14} /> Refresh operations
        </Button>
      </div>

      {counts.length > 0 && (
        <div className="meta-ops-summary" aria-label="Operations by state">
          {counts.map(({ state, count }) => (
            <StatusBadge
              key={state}
              status={STATE_META[state].badgeStatus}
              label={`${count} ${STATE_META[state].label.toLowerCase()}`}
            />
          ))}
        </div>
      )}

      {loading && <p role="status" className="meta-ops-note">Loading operations…</p>}
      {error && (
        <div role="alert" className="meta-ops-callout meta-ops-callout-error">
          Unable to load saved operations. Use Refresh operations to retry.
        </div>
      )}
      {!loading && !error && page.items.length === 0 && (
        <div className="meta-ops-callout meta-ops-empty">No saved operations.</div>
      )}

      <ul className="meta-ops-list">
        {page.items.map((operation) => {
          const meta = STATE_META[operation.state];
          const stamp = operation.finishedAt ?? operation.updatedAt ?? operation.createdAt;
          const when = timeAgo(stamp);
          const session = sessionInfo(operation);
          const took = durationLabel(operation.startedAt, operation.finishedAt);
          const tokens = tokenLabel(operation);
          const resolvedModel =
            operation.resolvedModel && operation.resolvedModel !== operation.requestedModel
              ? operation.resolvedModel
              : null;
          return (
            <li key={operation.operationId} className="meta-op-card" data-state={operation.state}>
              <div className="meta-op-card-top">
                <StatusBadge status={meta.badgeStatus} label={meta.label} />
                <button type="button" className="meta-op-title" onClick={() => void open(operation.operationId)}>
                  {operation.label ?? operation.purpose ?? operation.operationId}
                </button>
                {when && (
                  <time className="meta-op-when" dateTime={stamp}>
                    {when}
                  </time>
                )}
              </div>
              <p className="meta-op-caption">{meta.caption}</p>
              {operation.errorMessage && (
                <p className="meta-op-reason" title={operation.errorMessage}>
                  {operation.state === 'failed' ? 'Error' : 'Interrupted'}: {operation.errorMessage}
                </p>
              )}
              <dl className="meta-op-details">
                {session && (
                  <div className="meta-op-detail">
                    <dt>{session.label}</dt>
                    <dd title={session.id}>{shortId(session.id)}</dd>
                  </div>
                )}
                {took && (
                  <div className="meta-op-detail">
                    <dt>Time taken</dt>
                    <dd>{took}</dd>
                  </div>
                )}
                {resolvedModel && (
                  <div className="meta-op-detail">
                    <dt>Model used</dt>
                    <dd>{resolvedModel}</dd>
                  </div>
                )}
                {tokens && (
                  <div className="meta-op-detail">
                    <dt>Tokens</dt>
                    <dd>{tokens}</dd>
                  </div>
                )}
              </dl>
              <div className="meta-op-meta">
                {credits(operation)}{' · '}{operation.providerId ?? 'Provider unknown'}{' / '}{operation.requestedModel ?? 'Model unknown'}
                {!operation.hasResult && ' · No durable result yet'}
              </div>
            </li>
          );
        })}
      </ul>
      {page.nextCursor !== null && (
        <Button variant="ghost" className="meta-ops-more" disabled={loading} onClick={() => void loadPage(page.nextCursor)}>Load more operations</Button>
      )}
      {detail && (
        <div role="dialog" aria-modal="true" aria-label="Saved AI operation">
          <button type="button" onClick={close}>Close saved operation</button>
          <h4>{detail.id}</h4>
          {!detail.operation && !detail.failed && <p role="status">Loading saved result…</p>}
          {detail.failed && <>
            <p role="alert">Unable to load the saved result.</p>
            <button type="button" onClick={() => void open(detail.id)}>Retry saved result</button>
          </>}
          {detail.operation && <>
            <p>{detail.operation.state} · Outcome: {detail.operation.outcome} · {credits(detail.operation)}</p>
            <p>Application session: {detail.operation.sessionId ?? 'Unknown'} · Provider session: {detail.operation.providerSessionId ?? 'Unknown'}</p>
            {detail.operation.errorMessage && <p>{detail.operation.errorMessage}</p>}
            {detail.operation.resultText === null
              ? <p>No result was durably captured. This does not prove that no effects occurred.</p>
              : detail.operation.resultText === ''
                ? <p>The saved result is empty.</p>
                : <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '24rem', overflow: 'auto' }}>{detail.operation.resultText}</pre>}
          </>}
        </div>
      )}
    </section>
  );
}
