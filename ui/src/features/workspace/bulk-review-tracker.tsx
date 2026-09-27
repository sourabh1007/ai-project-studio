import { useEffect, useMemo, useReducer, useState } from 'react';
import { formatDuration } from '../../lib/format.js';
import { initialLiveState, reviewBoardActivityLines, type LiveState } from '../../lib/stream.js';
import { useApi } from '../../app/api-context.js';
import { useAgentUsage } from '../../hooks/use-agent-usage.js';
import { aggregateAgentUsage } from '../../lib/agent-usage.js';
import { AgentUsageValue } from '../../components/feature-agent-usage.js';
import {
  ActivityIcon,
  CheckIcon,
  ClockIcon,
  PullRequestIcon,
  RefreshIcon,
  WarningIcon,
} from '../../components/icons.js';
import { Spinner } from '../../components/loading.js';
import {
  reviewBoardRunStore,
  type ReviewBoardRunState,
} from '../review-board-page/review-board-run-store.js';
import type { TrackedPr } from './workspace-tabs.js';

type PrCardStatus = 'queued' | 'preparing' | 'reviewing' | 'done' | 'failed' | 'incomplete' | 'skipped' | 'partial';

interface PrCardModel {
  status: PrCardStatus;
  done: number;
  total: number;
  failed: number;
  skipped: number;
  error: string | null;
  recommendation: string | null;
}

export function deriveCard(state: ReviewBoardRunState): PrCardModel {
  const perspectives = state.board?.perspectives ?? [];
  const entries = perspectives.map((p) => state.progress[p.id]).filter(Boolean);
  const total = perspectives.length;
  const done = perspectives.filter((p) =>
    state.progress[p.id]?.status === 'done' && p.status !== 'not-started',
  ).length;
  const skipped = entries.filter((p) => p.status === 'skipped').length;
  const failed = entries.filter((p) => p.status === 'error').length;

  let status: PrCardStatus;
  if (state.queued) {
    status = 'queued';
  } else if (state.running) {
    status = 'reviewing';
  } else if (state.prep.active || (state.loading && !state.analyzed)) {
    status = 'preparing';
  } else if (state.loadError || state.prep.error) {
    status = 'failed';
  } else if (state.analyzed) {
    if (failed > 0) status = 'failed';
    else if (total > 0 && done === total) status = 'done';
    else if (total > 0 && skipped === total) status = 'skipped';
    else if (total > 0 && done + skipped === total) status = 'partial';
    else status = 'incomplete';
  } else {
    status = 'queued';
  }

  return {
    status,
    done,
    total,
    failed,
    skipped,
    error: state.prep.error ?? state.loadError ?? entries.find((p) => p.status === 'error')?.error ?? null,
    recommendation: state.board?.recommendation ?? null,
  };
}

const STATUS_LABEL: Record<PrCardStatus, string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  reviewing: 'Reviewing',
  done: 'Completed',
  failed: 'Failed',
  incomplete: 'Incomplete',
  skipped: 'Skipped',
  partial: 'Reviewed with skips',
};

const RECOMMENDATION_LABEL: Record<string, string> = {
  approve: 'Approve',
  'request-changes': 'Request changes',
  'needs-review': 'Needs review',
};

function StatusIcon({ status }: { status: PrCardStatus }) {
  if (status === 'reviewing' || status === 'preparing') {
    return <Spinner size={14} label={STATUS_LABEL[status]} />;
  }
  if (status === 'done') {
    return <CheckIcon size={14} />;
  }
  if (status === 'failed' || status === 'incomplete' || status === 'skipped' || status === 'partial') {
    return <WarningIcon size={14} />;
  }
  return <ClockIcon size={14} />;
}

/**
 * Live dashboard for a "Bulk PR Review": one row per selected pull request with
 * its review progress. It drives the shared {@link reviewBoardRunStore} — the
 * same store each PR's Review Board tab subscribes to — so progress here and in
 * the individual boards is always the one live run. Import/startup owns scheduling;
 * opening this dashboard only reads the existing review state.
 */
export function BulkReviewTracker({
  prs,
  title = 'Bulk PR Review',
  onOpen,
  live = initialLiveState,
}: {
  prs: TrackedPr[];
  title?: string;
  /** Focus (or open) the Review Board tab for a PR's feature. */
  onOpen?: (featureId: string) => void;
  live?: LiveState;
}) {
  const api = useApi();
  const featureIds = useMemo(() => prs.map((pr) => pr.featureId), [prs]);
  const usage = useAgentUsage(featureIds, 'Review board', undefined, live);
  const runApi = useMemo(
    () => ({
      getReviewBoard: api.getReviewBoard,
      analyzeReviewBoardPerspective: api.analyzeReviewBoardPerspective,
      analyzeReviewBoardPerspectives: api.analyzeReviewBoardPerspectives,
      getPrReview: api.getPrReview,
      retryPrReviewStep: api.retryPrReviewStep,
      settleReviewBoardQueue: api.settleReviewBoardQueue,
      pullLatestPrReview: api.pullLatestPrReview,
      getMetaPools: api.getMetaPools,
    }),
    [api],
  );

  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const unsubs = prs.map((pr) =>
      reviewBoardRunStore.subscribe(pr.featureId, force),
    );
    return () => unsubs.forEach((u) => u());
  }, [prs]);

  useEffect(() => {
    for (const pr of prs) void reviewBoardRunStore.load(pr.featureId, runApi);
  }, [prs, runApi]);

  const cards = prs.map((pr) => ({
    pr,
    model: deriveCard(reviewBoardRunStore.getState(pr.featureId)),
    timing: reviewBoardRunStore.getState(pr.featureId).timing,
  }));
  const completed = cards.filter((c) => c.model.status === 'done').length;
  const reviewing = cards.filter(
    (c) => c.model.status === 'reviewing' || c.model.status === 'preparing',
  ).length;
  const queued = cards.filter((c) => c.model.status === 'queued').length;
  const failed = cards.filter((c) => c.model.status === 'failed').length;
  const incomplete = cards.filter((c) => c.model.status === 'incomplete' || c.model.status === 'skipped').length;
  const withSkips = cards.filter((c) => c.model.status === 'partial').length;
  const active = reviewing > 0 || queued > 0;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const timings = cards.flatMap(({ timing }) => timing ? [timing] : []);
  const batchMs = timings.length
    ? (active ? now : Math.max(...timings.map((t) => t.finishedAt ?? now))) -
      Math.min(...timings.map((t) => t.startedAt))
    : null;

  return (
    <div className="bulk-review">
      <header className="bulk-review-head">
        <div className="bulk-review-title">
          <PullRequestIcon size={18} />
          <h2>{title}</h2>
          <span className="bulk-review-count">{prs.length} pull requests</span>
        </div>
        <div className="bulk-review-stats">
          <span className="brs" title="Combined vendor-reported Review Board AIC across these PRs' persisted history, including retries.">
            Review history: <AgentUsageValue usage={usage} />
          </span>
          {batchMs !== null && (
            <span className="brs" title="Wall-clock time since the first review started, including evidence preparation and queue waits; parallel review times are not added together.">
              <ClockIcon size={13} /> {active ? 'Batch elapsed' : 'Batch review time'}: {formatDuration(batchMs)}
            </span>
          )}
          <span className="brs brs-done">
            <CheckIcon size={13} /> {completed} completed
          </span>
          <span className="brs brs-run">
            <ActivityIcon size={13} /> {reviewing} in progress
          </span>
          <span className="brs brs-queued">
            <ClockIcon size={13} /> {queued} queued
          </span>
          {failed > 0 && (
            <span className="brs brs-failed">
              <WarningIcon size={13} /> {failed} failed
            </span>
          )}
          {incomplete > 0 && (
            <span className="brs brs-failed"><WarningIcon size={13} /> {incomplete} incomplete</span>
          )}
          {withSkips > 0 && (
            <span className="brs brs-queued"><WarningIcon size={13} /> {withSkips} with skips</span>
          )}
        </div>
      </header>

      <ul className="bulk-review-list">
        {cards.map(({ pr, model, timing }) => {
          const state = reviewBoardRunStore.getState(pr.featureId);
          const current = state.board?.perspectives.filter((perspective) =>
            ['analyzing', 'retrying'].includes(state.progress[perspective.id]?.status));
          const activity = current?.map((perspective) => {
            const lines = reviewBoardActivityLines(live, pr.featureId, perspective.id);
            return `${perspective.name}: ${lines.at(-1) ?? (state.progress[perspective.id]?.status === 'retrying' ? 'Retrying…' : 'Analyzing…')}`;
          }).join('\n');
          const pct =
            model.total > 0
              ? Math.round((model.done / model.total) * 100)
              : 0;
          const recommendation =
            model.recommendation &&
            (RECOMMENDATION_LABEL[model.recommendation] ?? model.recommendation);
          return (
            <li
              key={pr.featureId}
              className={`bulk-review-row is-${model.status}`}
            >
              <button
                type="button"
                className="brr-open"
                onClick={() => onOpen?.(pr.featureId)}
                title="Open this PR's Review Board"
              >
                <span className="brr-status" data-status={model.status}>
                  <StatusIcon status={model.status} />
                </span>
                <span className="brr-main">
                  <span className="brr-title">
                    <span className="brr-number">#{pr.number}</span>
                    <span className="brr-name">{pr.title}</span>
                  </span>
                  {model.status === 'preparing' && <span className="brr-activity">{state.prep.message}</span>}
                  {activity && <span className="brr-activity" title={activity}>{activity}</span>}
                  <span className="brr-bar" aria-hidden="true">
                    <span
                      className="brr-bar-fill"
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                </span>
                <span className="brr-meta">
                  <span title="Vendor-reported Review Board AIC across this PR's review history">
                    <AgentUsageValue usage={{
                      ...(usage.byFeature[pr.featureId] ?? aggregateAgentUsage([], 'Review board')),
                      loading: usage.loading, error: usage.error,
                    }} />
                  </span>
                  <span className="brr-state" title={model.error ?? undefined}>{STATUS_LABEL[model.status]}</span>
                  {timing && <span className="brr-progress" title="Latest full review: evidence preparation and analysis, excluding queue wait.">
                    {timing.finishedAt === null ? 'Elapsed' : 'Review time'}: {formatDuration((timing.finishedAt ?? now) - timing.startedAt)}
                  </span>}
                  {model.total > 0 && (
                    <span className="brr-progress">
                      {model.done}/{model.total} reviewed
                    </span>
                  )}
                  {model.status === 'done' && recommendation && (
                    <span
                      className={`brr-rec brr-rec-${model.recommendation}`}
                    >
                      {recommendation}
                    </span>
                  )}
                  {model.skipped > 0 && <span className="brr-warn">{model.skipped} skipped</span>}
                  {model.failed > 0 && <span className="brr-warn">{model.failed} failed</span>}
                </span>
              </button>
              {(model.status === 'failed' || model.status === 'incomplete' || model.status === 'skipped') && (
                <button
                  type="button"
                  className="brr-retry"
                  onClick={() => reviewBoardRunStore.enqueueBulk([pr.featureId], runApi, { retry: true })}
                  aria-label={`Retry review for PR #${pr.number}`}
                >
                  <RefreshIcon size={12} /> Retry
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
