import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
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

  return (
    <section className="settings-section" aria-label="Saved AI operations">
      <h3>Saved AI operations</h3>
      <p>Durable results and interrupted work. Unknown usage is not zero cost.</p>
      <button type="button" disabled={loading} onClick={() => void loadPage(null)}>Refresh operations</button>
      {loading && <p role="status">Loading operations…</p>}
      {error && <p role="alert">Unable to load saved operations. Use Refresh operations to retry.</p>}
      {!loading && !error && page.items.length === 0 && <p>No saved operations.</p>}
      <ul>
        {page.items.map((operation) => (
          <li key={operation.operationId}>
            <button type="button" onClick={() => void open(operation.operationId)}>
              {operation.label ?? operation.purpose ?? operation.operationId}
            </button>
            {' — '}{operation.state}{' · '}{credits(operation)}
            {' · '}{operation.providerId ?? 'Provider unknown'}{' / '}{operation.requestedModel ?? 'Model unknown'}
            {!operation.hasResult && ' · No durable result yet'}
          </li>
        ))}
      </ul>
      {page.nextCursor !== null && (
        <button type="button" disabled={loading} onClick={() => void loadPage(page.nextCursor)}>Load more operations</button>
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
