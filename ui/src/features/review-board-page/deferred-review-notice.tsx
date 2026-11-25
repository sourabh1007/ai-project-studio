import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ErrorText } from '../../components/ui.js';
import type { PrReview } from '../../lib/types.js';

export function DeferredReviewNotice({ featureId, error, onReady, onRetry }: {
  featureId: string;
  error: string | null;
  onReady: () => void;
  onRetry: () => void;
}) {
  const api = useApi();
  const [review, setReview] = useState<PrReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api.getPrReview(featureId).then((value) => {
      if (!active) return;
      setReview(value);
      if (!value.analysisDeferred && (value.changeGraph.status === 'generating' || value.changeGraph.status === 'pending')) setPreparing(true);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api, featureId]);
  useEffect(() => {
    if (!preparing) return;
    let active = true;
    let checking = false;
    const deadline = Date.now() + 600_000;
    const timer = window.setInterval(() => {
      if (Date.now() > deadline) {
        setPreparing(false);
        setPreparationError('Preparation is taking longer than expected. Check progress again; no review was restarted.');
        return;
      }
      if (checking) return;
      checking = true;
      void api.getPrReview(featureId).then((value) => {
        if (!active) return;
        setReview(value);
        if (value.changeGraph.status === 'ready') {
          setPreparing(false);
          onReady();
        } else if (value.changeGraph.status === 'failed') {
          setPreparing(false);
          setPreparationError(value.changeGraph.failure?.message ?? 'Change evidence preparation failed.');
        }
      }).catch((cause) => {
        if (active) {
          setPreparing(false);
          setPreparationError(cause instanceof Error ? cause.message : 'Could not check review preparation.');
        }
      }).finally(() => { checking = false; });
    }, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, featureId, onReady, preparing]);
  if (!review?.analysisDeferred && !preparing && !preparationError) return <>
    <ErrorText error={error} /><Button variant="ghost" onClick={onRetry}>Retry loading board</Button>
  </>;
  return <section aria-label="Imported review preparation">
    <h3>{preparing ? 'Preparing review evidence' : 'Imported without analysis'}</h3>
    <p>{preparing ? 'Preparation continues on the backend. No duplicate review will be started by this screen.'
      : 'Review analysis has not started. Prepare this review when you are ready to use the saved review setup.'}</p>
    {preparationError && <ErrorText error={preparationError} />}
    <Button disabled={busy || preparing} onClick={() => {
      setBusy(true);
      setPreparationError(null);
      void api.preparePrReview(featureId).then((value) => {
        setReview(value);
        if (value.changeGraph.status === 'ready') onReady();
        else setPreparing(true);
      }).catch((cause) => setPreparationError(cause instanceof Error ? cause.message : 'Could not prepare review.'))
        .finally(() => setBusy(false));
    }}>{busy ? 'Preparing…' : preparing ? 'Preparation in progress' : 'Prepare review'}</Button>
  </section>;
}
