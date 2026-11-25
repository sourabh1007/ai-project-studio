import { useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ErrorText, Modal } from '../../components/ui.js';
import type { ReviewPublication } from '../../lib/types.js';

export function ReviewPublicationHistory({ featureId, pullUrl, records, onUpdate, onClose }: {
  featureId: string;
  pullUrl: string;
  records: ReviewPublication[];
  onUpdate: (record: ReviewPublication) => void;
  onClose: () => void;
}) {
  const api = useApi();
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const reconcile = async (record: ReviewPublication) => {
    if (locked.current) return;
    locked.current = true;
    setChecking(record.key);
    setError(null);
    try {
      onUpdate(await api.reconcileReviewBoardPublication(featureId, record.key));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Publication could not be reconciled. No comment was resent.');
    } finally { locked.current = false; setChecking(null); }
  };
  return <Modal title="Publication recovery" size="lg" dismissible={!checking} onClose={onClose}>
    <p>These operations survive finding merges, splits and reruns. Reconciliation checks the provider; it never resends a comment or marks code fixed.</p>
    <a href={pullUrl} target="_blank" rel="noreferrer">Check comments on the PR</a>
    <ErrorText error={error} />
    {records.map((record, index) => <section key={record.key} className="rb-publication-status">
      <h3>Comment {index + 1} — {record.status}</h3>
      <p>{record.startedAt} · {record.input.path ? `${record.input.path}:${record.input.line}` : 'PR-level comment'}</p>
      <p>Review run: {record.input.expectedRunId ?? 'Legacy operation'}</p>
      <details><summary>Saved comment and operation identity</summary><p>{record.input.body}</p><code>{record.key}</code></details>
      {record.error && <p>{record.error}</p>}
      {record.status !== 'posted' && <Button disabled={Boolean(checking)} onClick={() => void reconcile(record)}>
        {checking === record.key ? 'Checking publication…' : `Reconcile publication ${index + 1}`}
      </Button>}
    </section>)}
  </Modal>;
}
