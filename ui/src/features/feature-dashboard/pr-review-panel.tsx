import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { ApiError } from '../../lib/api.js';
import { Button, ErrorText } from '../../components/ui.js';
import { RefreshIcon } from '../../components/icons.js';
import type { PrReview, PrReviewStatus } from '../../lib/types.js';

const STATUS_LABELS: Record<PrReviewStatus, string> = {
  pending: 'Queued',
  generating: 'Analyzing',
  ready: 'Ready',
  failed: 'Failed',
};

function Analyzing() {
  return (
    <div className="repo-context-active" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="repo-context-active-text">
        Analyzing pull request
        <span className="repo-context-dots" aria-hidden="true">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </span>
    </div>
  );
}

/**
 * The PR review panel shown for a pull-request review feature. It surfaces the
 * AI-generated summary and core analysis produced from the repository context
 * and the PR diff, with live status while the review is generating and a manual
 * refresh. It renders nothing for non-PR features.
 */
export function PrReviewPanel({
  featureId,
  liveReview,
}: {
  featureId: string;
  liveReview?: PrReview;
}) {
  const api = useApi();
  const [review, setReview] = useState<PrReview | null>(liveReview ?? null);
  const [notPr, setNotPr] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .getPrReview(featureId)
      .then((loaded) => {
        if (active) {
          // Don't clobber a live update that may have arrived first.
          setReview((prev) => prev ?? loaded);
        }
      })
      .catch((err) => {
        if (!active) {
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          setNotPr(true);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      active = false;
    };
  }, [api, featureId]);

  useEffect(() => {
    if (liveReview) {
      setReview(liveReview);
    }
  }, [liveReview]);

  if (notPr && !review) {
    return null;
  }

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      setReview(await api.refreshPrReview(featureId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  const status = review?.status ?? 'pending';
  const working = status === 'pending' || status === 'generating';
  const actionLabel = status === 'failed' ? 'Retry' : 'Refresh';

  return (
    <section className="pr-review" aria-label="Pull request review">
      <header className="pr-review-head">
        <div className="pr-review-title">
          <h3>PR review</h3>
          <span className={`pr-review-status pr-review-${status}`}>
            {STATUS_LABELS[status]}
          </span>
        </div>
        <Button
          variant="ghost"
          onClick={() => void refresh()}
          disabled={refreshing || working}
        >
          <RefreshIcon size={13} /> {refreshing ? `${actionLabel}ing…` : actionLabel}
        </Button>
      </header>

      {review && (
        <p className="pr-review-meta">
          <a href={review.pull.url} target="_blank" rel="noreferrer">
            #{review.pull.number} {review.pull.title}
          </a>
          {review.baseBranch && <span> · base {review.baseBranch}</span>}
          {review.changedFiles !== null && (
            <span> · {review.changedFiles} files changed</span>
          )}
        </p>
      )}

      {working && <Analyzing />}

      {review?.failure && (
        <div className="pr-review-failure" role="alert">
          <strong>Review generation failed</strong>
          <span>{review.failure.message}</span>
        </div>
      )}

      <ErrorText error={error} />

      {review?.summary && (
        <div className="pr-review-section">
          <h4>Summary</h4>
          <p className="pr-review-summary">{review.summary}</p>
        </div>
      )}

      {review?.coreAnalysis && (
        <div className="pr-review-section">
          <h4>Core analysis</h4>
          <pre className="pr-review-analysis">{review.coreAnalysis}</pre>
        </div>
      )}

      {!working && !review?.summary && !review?.coreAnalysis && !review?.failure && (
        <p className="muted">
          The review will appear here once analysis completes.
        </p>
      )}
    </section>
  );
}
