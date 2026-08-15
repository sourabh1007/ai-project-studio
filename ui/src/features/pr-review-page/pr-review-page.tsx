import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { ApiError } from '../../lib/api.js';
import { Button, ErrorText } from '../../components/ui.js';
import { CheckIcon, PrReviewIcon, RefreshIcon } from '../../components/icons.js';
import loadingGif from '../../assets/pr-review-loading.gif';
import { ChangeGraph } from './change-graph.js';
import { PrCommentsPanel, usePrComments } from './pr-comments.js';
import { StageProgress } from './stage-progress.js';
import type { StageStatus } from '../../lib/progress-stages.js';
import type {
  ChangeGraphCategory,
  MetaUsage,
  PrReview,
  PrReviewChatMessage,
  PrReviewStepBase,
  PrReviewStepKey,
  PrReviewStepStatus,
} from '../../lib/types.js';

const STATUS_LABELS: Record<PrReviewStepStatus, string> = {
  pending: 'Queued',
  generating: 'Analyzing',
  ready: 'Ready',
  failed: 'Failed',
};

/** Maps a PR-review step status onto the generic progress-stage vocabulary. */
const STEP_TO_STAGE_STATUS: Record<PrReviewStepStatus, StageStatus> = {
  pending: 'pending',
  generating: 'active',
  ready: 'done',
  failed: 'failed',
};

/** A rotating gif used as the real-progress indicator while a step generates. */
function GeneratingIndicator({ label }: { label: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const clock = `${mins}:${String(secs).padStart(2, '0')}`;
  return (
    <div className="pr-step-generating" role="status" aria-live="polite">
      <img
        className="pr-step-loading-gif"
        src={loadingGif}
        alt=""
        width={28}
        height={28}
        aria-hidden="true"
      />
      <span>{label}</span>
      <span className="pr-step-elapsed" aria-label="Elapsed time">
        {clock}
      </span>
    </div>
  );
}

/**
 * A live, auto-scrolling log of what a step's metasession is doing right now:
 * assistant messages, tool calls and diagnostics streamed from the running
 * metasession. Shown while a step generates so it never looks frozen. Keeps the
 * newest line pinned into view as entries stream in — but only while the reader
 * is already at the bottom, so manual scroll-back is never yanked away.
 */
function ActivityLog({ lines }: { lines: string[] }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const onScroll = () => {
    const box = boxRef.current;
    if (!box) {
      return;
    }
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    pinnedRef.current = distance < 24;
  };
  useEffect(() => {
    const box = boxRef.current;
    if (box && pinnedRef.current) {
      box.scrollTop = box.scrollHeight;
    }
  }, [lines.length]);
  if (lines.length === 0) {
    return null;
  }
  return (
    <div
      ref={boxRef}
      onScroll={onScroll}
      className="pr-activity"
      role="log"
      aria-label="Metasession activity"
      aria-live="polite"
    >
      {lines.map((line, i) => (
        <div key={`${i}-${line}`} className="pr-activity-line">
          {line}
        </div>
      ))}
    </div>
  );
}

/** Formats a compact "12.3K" token count. */
function formatTokens(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return String(n);
}

/** A distinctly marked line showing the metasession tokens/credits a step spent. */
function MetaUsageLine({ usage }: { usage: MetaUsage | null }) {
  if (!usage) {
    return null;
  }
  return (
    <p className="pr-step-usage" title={`Metasession ${usage.sessionId}`}>
      <span className="pr-meta-marker">metasession</span>
      <span>
        {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out
      </span>
      <span>· {usage.credits.toFixed(2)} credits</span>
    </p>
  );
}

/** The common status pill + retry affordance shared by both boxes. */
function StepStatus({
  step,
  onRetry,
  retrying,
}: {
  step: PrReviewStepBase;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="pr-step-status-actions">
      <span className={`pr-step-pill pr-step-pill-${step.status}`}>
        {STATUS_LABELS[step.status]}
      </span>
      {step.status === 'failed' && (
        <Button variant="ghost" onClick={onRetry} disabled={retrying}>
          <RefreshIcon size={13} /> {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      )}
    </div>
  );
}

/**
 * The dedicated PR Review page. Two grounded boxes: the problem/feature the PR
 * addresses (distilled from its description), and an animated node graph of the
 * changed files clustered under the high-level modules they belong to. Each box
 * shows real per-step progress, its metasession token/credit cost, and a retry
 * when it fails. Opened from the "PR Review" tree child of a PR feature.
 */
export function PrReviewPage({
  featureId,
  liveReview,
}: {
  featureId: string;
  liveReview?: PrReview;
}) {
  const api = useApi();
  const [review, setReview] = useState<PrReview | null>(liveReview ?? null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [alreadyApproved, setAlreadyApproved] = useState(false);
  const [retrying, setRetrying] = useState<PrReviewStepKey | null>(null);
  const [explaining, setExplaining] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const comments = usePrComments(featureId);

  useEffect(() => {
    let active = true;
    api
      .getPrReview(featureId)
      .then((loaded) => {
        if (active) {
          setReview((prev) => prev ?? loaded);
        }
      })
      .catch((err) => {
        if (!active) {
          return;
        }
        if (!(err instanceof ApiError && err.status === 404)) {
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

  useEffect(() => {
    setApproved(false);
    setApproving(false);
    setAlreadyApproved(false);
  }, [featureId]);

  // Polling fallback: while a step is generating, re-fetch the review on a timer
  // so the page always converges to the final state even if a live SSE update is
  // missed or arrives out of order with a "Re-run all" response (which would
  // otherwise leave the page stuck showing a stale generating/pending state).
  const working =
    review?.problemStatement.status === 'generating' ||
    review?.changeGraph.status === 'generating' ||
    review?.problemStatement.status === 'pending' ||
    review?.changeGraph.status === 'pending';
  useEffect(() => {
    if (!working) {
      return;
    }
    let active = true;
    const timer = setInterval(() => {
      api
        .getPrReview(featureId)
        .then((latest) => {
          if (active) {
            setReview(latest);
          }
        })
        .catch(() => {});
    }, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, featureId, working]);

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

  async function approve() {
    if (approving || approved) {
      return;
    }
    setApproving(true);
    setError(null);
    try {
      const result = await api.approvePrReview(featureId);
      setApproved(true);
      setAlreadyApproved(result.alreadyApproved === true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApproving(false);
    }
  }

  async function retry(step: PrReviewStepKey) {
    setRetrying(step);
    setError(null);
    try {
      setReview(await api.retryPrReviewStep(featureId, step));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(null);
    }
  }

  async function explainFile(path: string) {
    // Ignore repeat clicks while an explanation for this file is already running.
    if (explaining.has(path)) {
      return;
    }
    setExplaining((current) => new Set(current).add(path));
    setError(null);
    try {
      setReview(await api.explainPrReviewFile(featureId, path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExplaining((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
    }
  }

  const problem = review?.problemStatement ?? null;
  const graph = review?.changeGraph ?? null;

  const chatGraph =
    (category: ChangeGraphCategory) => async (messages: PrReviewChatMessage[]) =>
      (await api.chatPrReviewGraph(featureId, category, messages)).answer;

  return (
    <div className="pr-review-page">
      <header className="pr-review-page-head">
        <div className="pr-review-page-title">
          <span className="pr-review-page-icon" aria-hidden="true">
            <PrReviewIcon size={20} />
          </span>
          <div>
            <h2>PR Review</h2>
            {review && (
              <p className="pr-review-page-meta">
                <a href={review.pull.url} target="_blank" rel="noreferrer">
                  #{review.pull.number} {review.pull.title}
                </a>
                {review.baseBranch && <span> · base {review.baseBranch}</span>}
                {review.changedFiles !== null && (
                  <span> · {review.changedFiles} files changed</span>
                )}
              </p>
            )}
          </div>
        </div>
        <div className="pr-review-page-actions">
          <Button onClick={() => void approve()} disabled={approving || approved}>
            <CheckIcon size={13} />{' '}
            {approved
              ? alreadyApproved
                ? 'Already approved ✓'
                : 'Approved ✓'
              : approving
                ? 'Approving…'
                : 'Approve'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            <RefreshIcon size={13} /> {refreshing ? 'Re-running…' : 'Re-run all'}
          </Button>
        </div>
      </header>

      <ErrorText error={error} />

      {review && (
        <StageProgress
          stages={[
            {
              id: 'problemStatement',
              label: 'Problem statement',
              status: STEP_TO_STAGE_STATUS[review.problemStatement.status],
            },
            {
              id: 'changeGraph',
              label: 'Change graph',
              status: STEP_TO_STAGE_STATUS[review.changeGraph.status],
            },
          ]}
        />
      )}

      {!review && !error && <GeneratingIndicator label="Loading review…" />}

      {review && problem && (
        <section
          className={`pr-box pr-step-${problem.status}`}
          aria-label="Problem statement"
        >
          <header className="pr-step-head">
            <div className="pr-step-heading">
              <h3>Problem this PR addresses</h3>
              <p className="pr-step-blurb">
                Distilled by a metasession strictly from the PR description.
              </p>
            </div>
            <StepStatus
              step={problem}
              onRetry={() => void retry('problemStatement')}
              retrying={retrying === 'problemStatement'}
            />
          </header>

          {(problem.status === 'pending' || problem.status === 'generating') && (
            <GeneratingIndicator label={`${STATUS_LABELS[problem.status]}…`} />
          )}

          {(problem.status === 'generating' || problem.status === 'failed') && (
            <ActivityLog lines={problem.activity} />
          )}

          {problem.failure && (
            <div className="pr-step-failure" role="alert">
              <strong>Generation failed</strong>
              <span>{problem.failure.message}</span>
            </div>
          )}

          {problem.status === 'ready' && !problem.sufficient && (
            <p className="pr-step-insufficient" role="note">
              The PR description didn't carry enough detail to derive a
              meaningful problem statement.
            </p>
          )}

          {problem.content && (
            <p className="pr-problem-content">{problem.content}</p>
          )}

          <MetaUsageLine usage={problem.usage} />
        </section>
      )}

      {review && graph && (
        <section
          className={`pr-box pr-box-graph pr-step-${graph.status}`}
          aria-label="Changed files graph"
        >
          <header className="pr-step-head">
            <div className="pr-step-heading">
              <h3>Files changed</h3>
              <p className="pr-step-blurb">
                Split into <strong>code changes</strong> and{' '}
                <strong>test changes</strong>. Nodes are colour-coded by how the
                PR changed each file; select a node to see what it does, what the
                change means, and the actual diff.
              </p>
            </div>
            <StepStatus
              step={graph}
              onRetry={() => void retry('changeGraph')}
              retrying={retrying === 'changeGraph'}
            />
          </header>

          {(graph.status === 'pending' || graph.status === 'generating') && (
            <GeneratingIndicator label={`${STATUS_LABELS[graph.status]}…`} />
          )}

          {(graph.status === 'generating' || graph.status === 'failed') && (
            <ActivityLog lines={graph.activity} />
          )}

          {graph.failure && (
            <div className="pr-step-failure" role="alert">
              <strong>Generation failed</strong>
              <span>{graph.failure.message}</span>
            </div>
          )}

          {graph.status === 'ready' && (
            <div className="pr-graph-groups">
              <div className="pr-graph-group">
                <h4 className="pr-graph-group-title">
                  Code changes
                  <span className="pr-graph-count">
                    {
                      graph.nodes.filter(
                        (n) => n.category === 'code' && n.kind === 'changed',
                      ).length
                    }
                  </span>
                </h4>
                <ChangeGraph
                  step={graph}
                  category="code"
                  explaining={explaining}
                  onExplainFile={explainFile}
                  onChat={chatGraph('code')}
                  comments={comments}
                />
              </div>
              <div className="pr-graph-group">
                <h4 className="pr-graph-group-title">
                  Test changes
                  <span className="pr-graph-count">
                    {
                      graph.nodes.filter(
                        (n) => n.category === 'test' && n.kind === 'changed',
                      ).length
                    }
                  </span>
                </h4>
                <ChangeGraph
                  step={graph}
                  category="test"
                  explaining={explaining}
                  onExplainFile={explainFile}
                  onChat={chatGraph('test')}
                  comments={comments}
                />
              </div>
            </div>
          )}

          <MetaUsageLine usage={graph.usage} />
        </section>
      )}

      {review && <PrCommentsPanel comments={comments} />}
    </div>
  );
}
