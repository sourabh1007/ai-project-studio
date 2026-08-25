import { useEffect, useMemo, useRef, useState, useCallback, useSyncExternalStore } from 'react';
import { useApi } from '../../app/api-context.js';
import { ApiError } from '../../lib/api.js';
import { Button, ErrorText } from '../../components/ui.js';
import { useUsageStream } from '../../hooks/use-usage-stream.js';
import { reviewBoardActivityLines } from '../../lib/stream.js';
import {
  reviewBoardRunStore,
  type PerspectiveProgress,
} from './review-board-run-store.js';
import { ChangeGraph } from '../pr-review-page/change-graph.js';
import { usePrComments, CommentableDiff } from '../pr-review-page/pr-comments.js';
import {
  allPerspectivesReviewed,
  isPerspectiveReviewed,
  perspectiveBadgeLabel,
  reviewedCount,
} from '../../lib/review-signoff.js';
import {
  evidencePath,
  resolutionOf,
  splitIntoBullets,
  type FindingResolution,
} from '../../lib/review-format.js';
import {
  AiChatIcon,
  AiMagicIcon,
  CheckIcon,
  ClockIcon,
  CloseIcon,
  ExpandIcon,
  PrReviewIcon,
  RefreshIcon,
  RestoreIcon,
  SendIcon,
} from '../../components/icons.js';
import type {
  ChangeGraphStep,
  CheckStatus,
  DetectedItem,
  ReviewBoard,
  ReviewBoardChatMessage,
  ReviewBoardRatingChange,
  ReviewPerspective,
  ReviewRisk,
  ReviewStatus,
} from '../../lib/types.js';

const RISK_LABEL: Record<ReviewRisk, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
  unknown: 'Unrated',
};

const STATUS_LABEL: Record<ReviewStatus, string> = {
  'not-started': 'Not started',
  'needs-review': 'Needs review',
  warning: 'Warning',
  blocked: 'Blocking',
  approved: 'Approved',
  'not-applicable': 'N/A',
};

const RECOMMENDATION_LABEL: Record<ReviewBoard['recommendation'], string> = {
  approve: 'Approve',
  'request-changes': 'Request changes',
  'needs-review': 'Needs review',
};

const CHECK_STATUS_LABEL: Record<CheckStatus, string> = {
  pass: 'Verified — no issue',
  concern: 'Concern raised',
  na: 'Not applicable',
};

const CHECK_STATUS_GLYPH: Record<CheckStatus, string> = {
  pass: '✓',
  concern: '!',
  na: '–',
};

/** A tiny coloured marker for a status/risk, kept text-labelled for a11y. */
function Marker({
  kind,
  value,
}: {
  kind: 'status' | 'risk';
  value: string;
}) {
  return (
    <span className={`rb-marker rb-${kind}-${value}`}>
      {kind === 'risk'
        ? RISK_LABEL[value as ReviewRisk]
        : STATUS_LABEL[value as ReviewStatus]}
    </span>
  );
}

function DetectedList({ title, items }: { title: string; items: DetectedItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="rb-detected">
      <span className="rb-detected-title">{title}</span>
      <span className="rb-detected-values">
        {items.map((i) => i.name).join(', ')}
      </span>
    </div>
  );
}

/** Where an evidence link should open the Code Review — optionally a file. */
export interface CodeReviewTarget {
  path?: string;
}

/**
 * An evidence source label. When the board can open the underlying Code Review
 * (where the change graph, diffs and changed files live), it renders as a real
 * link that jumps there — straight to the referenced file's diff (with an
 * inline comment box) when the source names one; otherwise it's a plain label.
 */
function EvidenceSource({
  source,
  onOpenCodeReview,
}: {
  source: string;
  onOpenCodeReview?: (target?: CodeReviewTarget) => void;
}) {
  if (!onOpenCodeReview) {
    return <span className="rb-evidence-source">{source}</span>;
  }
  const path = evidencePath(source);
  return (
    <button
      type="button"
      className="rb-evidence-source rb-evidence-link"
      onClick={() => onOpenCodeReview(path ? { path } : undefined)}
      title={
        path
          ? `Open ${path} diff and comment inline`
          : 'Open in Code Review'
      }
    >
      {source}
    </button>
  );
}

/** The "Explain Review Model" panel — why this board looks the way it does. */
function ExplainModel({
  board,
  onOpenCodeReview,
}: {
  board: ReviewBoard;
  onOpenCodeReview?: (target?: CodeReviewTarget) => void;
}) {
  const { model } = board;
  const languages =
    [...model.primaryLanguages, ...model.secondaryLanguages].join(', ') ||
    'None detected';
  return (
    <details className="rb-explain">
      <summary className="rb-explain-summary">
        <span className="rb-explain-title">Why this review model</span>
        <span className="rb-explain-inline">
          {model.projectType} ({Math.round(model.projectTypeConfidence * 100)}%)
          {' · '}
          {languages}
          {' · '}
          {model.deploymentModel || 'no deployment model'}
        </span>
      </summary>
      <div className="rb-explain-body">
        <div className="rb-explain-grid">
          <div>
            <span className="rb-meta-label">Blast-radius dimensions</span>
            <span className="rb-meta-value">
              {model.blastRadiusDimensions.join(', ')}
            </span>
          </div>
          <DetectedList title="Configuration" items={model.configurationSystems} />
          <DetectedList title="Contracts" items={model.contracts} />
          <DetectedList title="Test signals" items={model.testSignals} />
        </div>
        {model.evidence.length > 0 && (
          <ul className="rb-evidence">
            {model.evidence.map((e, i) => (
              <li key={i}>
                <EvidenceSource
                  source={e.source}
                  onOpenCodeReview={onOpenCodeReview}
                />
                <span className="rb-evidence-reason">{e.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

/** The context-aware review agent: a scoped chat over the selected perspective. */
function ReviewAgent({
  featureId,
  pullNumber,
  perspective,
  focused,
  onToggleFocus,
  onRatingChange,
  onClose,
}: {
  featureId: string;
  pullNumber: number;
  perspective: ReviewPerspective | null;
  focused: boolean;
  onToggleFocus: () => void;
  onRatingChange: (change: ReviewBoardRatingChange) => void;
  onClose: () => void;
}) {
  const api = useApi();
  const [messages, setMessages] = useState<ReviewBoardChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const content = input.trim();
    if (content.length === 0 || pending) return;
    const next: ReviewBoardChatMessage[] = [
      ...messages,
      { role: 'user', content },
    ];
    setMessages(next);
    setInput('');
    setPending(true);
    setError(null);
    try {
      const reply = await api.chatReviewBoard(
        featureId,
        perspective?.id ?? null,
        next,
      );
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: reply.answer },
      ]);
      if (reply.ratingChange) {
        onRatingChange(reply.ratingChange);
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'The review agent is unavailable.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <aside className="rb-agent" aria-label="Review agent">
      <div className="rb-agent-head">
        <h3 className="rb-card-header">
          <AiChatIcon size={16} /> Engineering Review Agent
        </h3>
        <FocusToggle
          active={focused}
          label="review agent"
          onToggle={onToggleFocus}
        />
        <button
          type="button"
          className="rb-agent-close"
          onClick={onClose}
          title="Minimise the review agent"
          aria-label="Minimise the review agent"
        >
          <CloseIcon size={15} />
        </button>
      </div>
      <p className="rb-agent-context">
        Context: #{pullNumber}
        {perspective ? ` · ${perspective.name}` : ' · whole board'}
      </p>
      <div className="rb-agent-thread">
        {messages.length === 0 && !pending && (
          <p className="rb-agent-hint">
            Ask why a risk was marked, challenge a finding, or ask the agent to
            draft a PR comment for this{' '}
            {perspective ? 'perspective' : 'review'}.
            {perspective && (
              <>
                {' '}
                Point at concrete code and the agent will re-evaluate — it only
                changes the rating once the evidence convinces it.
              </>
            )}
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`rb-agent-msg rb-agent-${m.role}`}>
            {m.content}
          </div>
        ))}
        {pending && <div className="rb-agent-msg rb-agent-assistant">…</div>}
      </div>
      {error && <ErrorText error={error} />}
      <form
        className="rb-agent-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          className="rb-agent-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the review agent…"
          aria-label="Message the review agent"
          disabled={pending}
        />
        <Button
          variant="primary"
          type="submit"
          disabled={pending || input.trim().length === 0}
        >
          <SendIcon size={14} />
        </Button>
      </form>
    </aside>
  );
}

export function ReviewBoardPage({
  featureId,
  onOpenCodeReview,
}: {
  featureId: string;
  onOpenCodeReview?: (target?: CodeReviewTarget) => void;
}) {
  const api = useApi();
  // The analysis run lives in a persistent, per-feature store so it keeps going
  // when the reviewer switches tabs/windows and this page unmounts — returning
  // shows live progress instead of restarting. The API adapter is memoised so
  // the store always drives the same stable client.
  const runApi = useMemo(
    () => ({
      getReviewBoard: api.getReviewBoard,
      analyzeReviewBoardPerspective: api.analyzeReviewBoardPerspective,
      getPrReview: api.getPrReview,
      pullLatestPrReview: api.pullLatestPrReview,
    }),
    [api],
  );
  const state = useSyncExternalStore(
    (listener) => reviewBoardRunStore.subscribe(featureId, listener),
    () => reviewBoardRunStore.getState(featureId),
  );
  const { board, loading, loadError: error, analyzed, progress, signoff, resolutions, prep } =
    state;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A pending "Analyze with AI" click awaiting the take-latest confirmation.
  // `scope` is 'all' (whole board) or a perspective id (single perspective).
  const [pendingAnalyze, setPendingAnalyze] = useState<{ scope: string } | null>(
    null,
  );
  // Which of the three panels is expanded to fill the body, or null for the
  // default three-column layout.
  const [focus, setFocus] = useState<'nav' | 'canvas' | 'agent' | null>(null);
  // Lets the reviewer dismiss the "reviewing…" progress banner for the run.
  const [bannerHidden, setBannerHidden] = useState(false);
  // The review agent is minimised by default (chat-style) so it never competes
  // with the findings for horizontal space; the reviewer opens it on demand.
  const [agentOpen, setAgentOpen] = useState(false);
  // Whether the opened agent drawer is expanded to a wider reading width.
  const [agentExpanded, setAgentExpanded] = useState(false);
  useEffect(() => {
    if (board && selectedId === null) {
      setSelectedId(board.perspectives[0]?.id ?? null);
    }
  }, [board, selectedId]);

  const load = useMemo(
    () => () => reviewBoardRunStore.load(featureId, runApi),
    [featureId, runApi],
  );
  const analyze = useMemo(
    () => () => setPendingAnalyze({ scope: 'all' }),
    [],
  );
  const analyzeOne = useMemo(
    () => (perspectiveId: string) => setPendingAnalyze({ scope: perspectiveId }),
    [],
  );
  // Runs the analysis the reviewer just confirmed, optionally taking the latest
  // from the remote first (re-provision the PR worktree + rebuild the graph).
  const runPending = useMemo(
    () => (takeLatest: boolean) => {
      setPendingAnalyze((pending) => {
        if (pending) {
          setBannerHidden(false);
          if (pending.scope === 'all') {
            void reviewBoardRunStore.analyze(featureId, runApi, { takeLatest });
          } else {
            void reviewBoardRunStore.analyzeOne(
              featureId,
              pending.scope,
              runApi,
              { takeLatest },
            );
          }
        }
        return null;
      });
    },
    [featureId, runApi],
  );
  const retryFailed = useMemo(
    () => () => reviewBoardRunStore.retryFailed(featureId, runApi),
    [featureId, runApi],
  );
  const reset = useMemo(
    () => () => reviewBoardRunStore.reset(featureId, runApi),
    [featureId, runApi],
  );
  const setPerspectiveReviewed = useMemo(
    () => (perspectiveId: string, reviewed: boolean) =>
      reviewBoardRunStore.setPerspectiveReviewed(
        featureId,
        perspectiveId,
        reviewed,
      ),
    [featureId],
  );
  const markPrReviewed = useMemo(
    () => (ids: string[]) => reviewBoardRunStore.markPrReviewed(featureId, ids),
    [featureId],
  );
  const clearPrReviewed = useMemo(
    () => () => reviewBoardRunStore.clearPrReviewed(featureId),
    [featureId],
  );
  const setFindingResolution = useMemo(
    () => (findingId: string, resolution: FindingResolution | null) =>
      reviewBoardRunStore.setFindingResolution(featureId, findingId, resolution),
    [featureId],
  );

  // Load the clean board on mount; the store no-ops if a run is already live.
  useEffect(() => {
    void reviewBoardRunStore.load(featureId, runApi);
  }, [featureId, runApi]);

  // The change graph drives the Architecture & Code Flow perspective's code-flow
  // diagram (the same graph the PR "code review" renders). It lives on the PR
  // review, so fetch it here and refresh whenever the board is (re)generated —
  // e.g. after taking the latest — so the diagram tracks the code under review.
  const [changeGraph, setChangeGraph] = useState<ChangeGraphStep | null>(null);
  // Live PR comment threads — lets reviewers comment directly on a line in the
  // focused code-flow diagram, exactly as they can on the PR code review page.
  const comments = usePrComments(featureId);
  // Clicking an evidence link opens the referenced file's diff *inline* here (a
  // focused, commentable diff) instead of navigating to the full Code Review
  // page. We source the per-file diff from the change graph the page already
  // loaded; only when no diff is available do we fall back to the full review.
  const [diffTarget, setDiffTarget] = useState<{
    path: string;
    diff: string;
  } | null>(null);
  const openEvidence = useCallback(
    (target?: CodeReviewTarget) => {
      const path = target?.path;
      if (path && changeGraph) {
        const base = path.split(/[\\/]/).pop() ?? path;
        const match =
          changeGraph.nodes.find((n) => n.path === path && n.diff) ??
          changeGraph.nodes.find(
            (n) => n.diff && (n.path.endsWith(path) || n.path.endsWith(base)),
          );
        if (match) {
          setDiffTarget({ path: match.path, diff: match.diff });
          return;
        }
      }
      onOpenCodeReview?.(target);
    },
    [changeGraph, onOpenCodeReview],
  );
  useEffect(() => {
    let cancelled = false;
    void runApi
      .getPrReview(featureId)
      .then((review) => {
        if (!cancelled) setChangeGraph(review.changeGraph);
      })
      .catch(() => {
        if (!cancelled) setChangeGraph(null);
      });
    return () => {
      cancelled = true;
    };
  }, [featureId, runApi, board?.generatedAt]);

  const selected =
    board?.perspectives.find((p) => p.id === selectedId) ?? null;
  // The Architecture & Code Flow perspective renders a code-flow diagram (the PR
  // change graph) in place of the verbose "what was checked" narrative.
  const isArchitecture = selected?.id === 'architecture';
  const selectedProgress: PerspectiveProgress =
    (selectedId && progress[selectedId]) || {
      status: 'idle',
      skipReason: null,
      checked: null,
      rationale: [],
      checks: [],
      error: null,
      attempt: 0,
    };

  const progressValues = Object.values(progress);
  // Live per-perspective activity streamed from the backend over SSE — shows,
  // in real time, exactly what the AI reviewer is doing for the selected lens.
  const live = useUsageStream();
  const activityLines = selectedId
    ? reviewBoardActivityLines(live, featureId, selectedId)
    : [];
  const analyzing =
    prep.active ||
    progressValues.some(
      (p) =>
        p.status === 'analyzing' ||
        p.status === 'pending' ||
        p.status === 'retrying',
    );
  const analyzedCount = progressValues.filter(
    (p) => p.status === 'done' || p.status === 'skipped' || p.status === 'error',
  ).length;
  const failedCount = progressValues.filter(
    (p) => p.status === 'error',
  ).length;
  const totalPerspectives = board?.perspectives.length ?? 0;

  const perspectiveIds = board?.perspectives.map((p) => p.id) ?? [];
  const reviewedN = reviewedCount(signoff, perspectiveIds);
  const allReviewed = allPerspectivesReviewed(signoff, perspectiveIds);
  const prReviewed = signoff.prReviewedAt !== null;
  const selectedReviewed = selectedId
    ? isPerspectiveReviewed(signoff, selectedId)
    : false;
  const selectedAnalyzing =
    selectedProgress.status === 'analyzing' ||
    selectedProgress.status === 'retrying' ||
    selectedProgress.status === 'pending';

  const detailRef = useRef<HTMLElement | null>(null);
  const firstSelection = useRef(true);
  useEffect(() => {
    // Bring the detail into view whenever the reviewer picks a perspective,
    // but not on the very first render (that would yank the page down on load).
    if (firstSelection.current) {
      firstSelection.current = false;
      return;
    }
    detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selectedId]);

  if (loading && !board) {
    return (
      <div className="rb-page rb-state" role="status">
        Loading review board…
      </div>
    );
  }

  if (error && !board) {
    return (
      <div className="rb-page rb-state">
        <ErrorText error={error} />
        <Button variant="ghost" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!board) return null;

  return (
    <div className="rb-page">
      <header className="rb-header">
        <div className="rb-header-main">
          <h2 className="rb-title">
            <PrReviewIcon size={18} /> Review Board
          </h2>
          <p className="rb-subtitle">
            #{board.pull.number} · {board.pull.title}
            {board.pull.headSha ? (
              <span
                className="rb-commit"
                title={`Reviewing commit ${board.pull.headSha}`}
              >
                @ {board.pull.headSha.slice(0, 8)}
              </span>
            ) : null}
          </p>
        </div>
        <div className="rb-header-side">
          <span
            className={`rb-reco rb-reco-${
              analyzing
                ? 'reviewing'
                : prReviewed
                  ? 'approve'
                  : board.recommendation
            }`}
          >
            {analyzing
              ? `Reviewing ${analyzedCount}/${totalPerspectives}`
              : prReviewed
                ? 'PR reviewed'
                : RECOMMENDATION_LABEL[board.recommendation]}
          </span>
          <span className="rb-review-progress" title="Perspectives you have reviewed">
            {reviewedN}/{totalPerspectives} reviewed
          </span>
          {prReviewed ? (
            <button
              type="button"
              className="rb-act rb-act-icon rb-act-success"
              onClick={() => clearPrReviewed()}
              title="PR marked reviewed — click to re-open"
              aria-label="Re-open PR"
            >
              <RestoreIcon size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="rb-act rb-act-icon rb-act-primary"
              onClick={() => markPrReviewed(perspectiveIds)}
              disabled={!allReviewed}
              title={
                allReviewed
                  ? 'Mark the whole PR reviewed'
                  : 'Review every perspective first'
              }
              aria-label="Mark PR reviewed"
            >
              <CheckIcon size={15} />
            </button>
          )}
          <button
            type="button"
            className="rb-act rb-act-icon rb-act-primary"
            onClick={() => void analyze()}
            disabled={analyzing}
            title={
              analyzing
                ? 'Analyzing…'
                : analyzed
                  ? 'Re-analyze all perspectives with AI'
                  : 'Analyze all perspectives with AI'
            }
            aria-label={analyzing ? 'Analyzing' : 'Analyze with AI'}
          >
            {analyzing ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <AiMagicIcon size={15} />
            )}
          </button>
          <button
            type="button"
            className="rb-act rb-act-icon"
            onClick={() => reset()}
            title={analyzing ? 'Stop & reset' : 'Reset'}
            aria-label={analyzing ? 'Stop & reset' : 'Reset'}
          >
            <RefreshIcon size={14} />
          </button>
        </div>
      </header>

      {failedCount > 0 && !analyzing && (
        <div className="rb-analyze-error" role="alert">
          <ErrorText
            error={`${failedCount} perspective${
              failedCount === 1 ? '' : 's'
            } couldn't be analysed after automatic retries.`}
          />
          <Button variant="ghost" onClick={() => void retryFailed()}>
            <RefreshIcon size={14} /> Retry failed
          </Button>
        </div>
      )}

      {analyzing && !bannerHidden && (
        <div className="rb-analyzing" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>
            Reviewing {analyzedCount} of {totalPerspectives} perspectives —
            findings appear as each one completes. Runs one at a time and keeps
            going if you switch tabs. Select any perspective to follow along.
          </span>
          <button
            type="button"
            className="rb-banner-close"
            aria-label="Dismiss progress message"
            title="Dismiss"
            onClick={() => setBannerHidden(true)}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      )}

      {prep.active && (
        <div className="rb-analyzing" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>{prep.message}</span>
        </div>
      )}

      {prep.error && (
        <div className="rb-analyze-error" role="alert">
          <ErrorText error={prep.error} />
          <Button
            variant="ghost"
            onClick={() => reviewBoardRunStore.clearPrepError(featureId)}
          >
            <CloseIcon size={14} /> Dismiss
          </Button>
        </div>
      )}

      {pendingAnalyze && (
        <div
          className="rb-confirm-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Analyze with AI"
          onClick={() => setPendingAnalyze(null)}
        >
          <div
            className="rb-confirm"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="rb-confirm-title">Take the latest first?</h3>
            <p className="rb-confirm-body">
              Fetch the latest from the remote branch and rebuild the change
              graph before analyzing, or analyze the version you have now.
            </p>
            <div className="rb-confirm-actions">
              <Button variant="primary" onClick={() => runPending(true)}>
                <RefreshIcon size={14} /> Take latest &amp; analyze
              </Button>
              <Button variant="ghost" onClick={() => runPending(false)}>
                <AiMagicIcon size={14} /> Analyze current
              </Button>
              <button
                type="button"
                className="rb-confirm-cancel"
                onClick={() => setPendingAnalyze(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="rb-summary">
        <span>
          <strong>{board.summary.open}</strong> open
        </span>
        <span>
          <strong>{board.summary.blocking}</strong> blocking
        </span>
        <span>
          <strong>{board.summary.warnings}</strong> warnings
        </span>
        <span>
          <strong>{board.summary.suggestions}</strong> suggestions
        </span>
        <span className="rb-summary-model">
          {board.model.projectType} · {board.changedFiles} file
          {board.changedFiles === 1 ? '' : 's'} changed
        </span>
      </div>

      <div className="rb-body" data-focus={focus ?? undefined}>
        <nav className="rb-nav" aria-label="Review perspectives">
          <div className="rb-panel-bar">
            <span className="rb-panel-bar-title">Perspectives</span>
            <FocusToggle
              active={focus === 'nav'}
              label="perspectives list"
              onToggle={() => setFocus(focus === 'nav' ? null : 'nav')}
            />
          </div>
          {board.perspectives.map((p) => {
            const state = progress[p.id]?.status ?? 'idle';
            const navAnalyzing =
              state === 'analyzing' ||
              state === 'retrying' ||
              state === 'pending';
            const navReviewed = isPerspectiveReviewed(signoff, p.id);
            return (
              <button
                key={p.id}
                type="button"
                className={`rb-nav-item ${
                  p.id === selectedId ? 'is-active' : ''
                }`.trim()}
                onClick={() => setSelectedId(p.id)}
              >
                <span className="rb-nav-name">{p.name}</span>
                <span className="rb-nav-markers">
                  {state === 'pending' && (
                    <ClockIcon
                      size={13}
                      className="rb-nav-ico rb-nav-queued-ico"
                    />
                  )}
                  {(state === 'analyzing' || state === 'retrying') && (
                    <span
                      className="spinner rb-nav-spin"
                      aria-label={state === 'retrying' ? 'Retrying' : 'Analyzing'}
                      role="status"
                    />
                  )}
                  {state === 'error' && (
                    <span className="rb-nav-err" title="Analysis failed">
                      !
                    </span>
                  )}
                  {state === 'skipped' && (
                    <span
                      className="rb-dot rb-dot-ring rb-nav-skip-dot"
                      title="Skipped by the AI reviewer"
                    />
                  )}
                  {state === 'done' && p.findings.length === 0 && (
                    <CheckIcon
                      size={13}
                      className="rb-nav-ico rb-nav-clean-ico"
                    />
                  )}
                  <span
                    className={`rb-dot ${
                      navAnalyzing ? 'rb-dot-reviewing' : `rb-status-${p.status}`
                    }`}
                    title={perspectiveBadgeLabel(navAnalyzing, p.status)}
                  />
                  <span
                    className={`rb-dot rb-dot-ring rb-risk-${p.risk}`}
                    title={`Risk: ${RISK_LABEL[p.risk]}`}
                  />
                  {navReviewed && (
                    <CheckIcon
                      size={14}
                      className="rb-nav-ico rb-nav-reviewed-ico"
                    />
                  )}
                  {p.findings.length > 0 && (
                    <span className="rb-nav-count">{p.findings.length}</span>
                  )}
                </span>
              </button>
            );
          })}
        </nav>

        <main className="rb-canvas">
          <div className="rb-panel-bar">
            <span className="rb-panel-bar-title">Detail</span>
            <FocusToggle
              active={focus === 'canvas'}
              label="detail panel"
              onToggle={() => setFocus(focus === 'canvas' ? null : 'canvas')}
            />
          </div>
          {selected && (
            <section className="rb-detail" ref={detailRef}>
              <div className="rb-detail-head">
                <h3 className="rb-section-header">{selected.name}</h3>
                {selected.source === 'detected' && (
                  <span className="rb-card-badge">Detected</span>
                )}
                {(selectedProgress.status === 'analyzing' ||
                  selectedProgress.status === 'retrying') && (
                  <span className="rb-detail-working">
                    <span className="spinner" aria-hidden="true" />{' '}
                    {selectedProgress.status === 'retrying'
                      ? `Retrying (${selectedProgress.attempt}/3)…`
                      : 'AI reviewing…'}
                  </span>
                )}
                <span className="rb-detail-spacer" />
                <span
                  className={`rb-nav-verdict rb-verdict-${
                    selectedAnalyzing ? 'reviewing' : selected.status
                  }`}
                >
                  {perspectiveBadgeLabel(selectedAnalyzing, selected.status)}
                </span>
                <Marker kind="risk" value={selected.risk} />
                <button
                  type="button"
                  className="rb-act rb-act-icon"
                  onClick={() => void analyzeOne(selected.id)}
                  disabled={
                    selectedProgress.status === 'analyzing' ||
                    selectedProgress.status === 'retrying' ||
                    selectedProgress.status === 'pending'
                  }
                  title={
                    selectedProgress.status === 'done' ||
                    selectedProgress.status === 'skipped'
                      ? 'Re-analyze this perspective'
                      : 'Analyze this perspective'
                  }
                  aria-label="Analyze this perspective"
                >
                  <AiMagicIcon size={14} />
                </button>
                <button
                  type="button"
                  className={`rb-act rb-act-icon ${
                    selectedReviewed ? 'rb-act-success' : 'rb-act-primary'
                  }`}
                  onClick={() =>
                    setPerspectiveReviewed(selected.id, !selectedReviewed)
                  }
                  disabled={selectedAnalyzing}
                  title={
                    selectedReviewed
                      ? 'You reviewed this perspective — click to undo'
                      : 'Mark this perspective reviewed'
                  }
                  aria-label={
                    selectedReviewed
                      ? 'Reviewed by you'
                      : 'Mark this perspective reviewed'
                  }
                >
                  <CheckIcon size={15} />
                </button>
              </div>
              <p className="rb-detail-why">{selected.why}</p>
              <div className="rb-detail-meta">
                <span>
                  <strong>{selected.findings.length}</strong> finding
                  {selected.findings.length === 1 ? '' : 's'}
                </span>
                <span>·</span>
                <span>
                  Reviewing across {board.model.blastRadiusDimensions.join(', ')}
                </span>
              </div>

              {selectedProgress.agentAdjustment && (
                <div className="rb-adjusted" role="note">
                  <span className="rb-adjusted-label">
                    Rating updated by the review agent
                  </span>
                  <p className="rb-adjusted-text">
                    You challenged this rating and the agent was convinced to
                    change it. Why:{' '}
                    <em>{selectedProgress.agentAdjustment.justification}</em>
                  </p>
                </div>
              )}

              {isArchitecture &&
                (changeGraph && changeGraph.nodes.length > 0 ? (
                  <div className="rb-codeflow">
                    <span className="rb-codeflow-label">
                      Code flow — how the changed files connect
                    </span>
                    <div className="rb-codeflow-graph">
                      <ChangeGraph
                        step={changeGraph}
                        category="code"
                        comments={comments}
                      />
                    </div>
                    <p className="rb-checked-hint">
                      Orange nodes are files this PR changed; blue nodes are
                      callers that reference them. Click a file to read its diff
                      and comment. →
                    </p>
                  </div>
                ) : (
                  <div className="rb-codeflow rb-codeflow-empty" role="note">
                    <span className="rb-codeflow-label">Code flow</span>
                    <p className="rb-checked-hint">
                      {changeGraph
                        ? 'No code-flow graph yet — run the analysis (or take the latest) to build it.'
                        : 'Loading the code-flow graph…'}
                    </p>
                  </div>
                ))}

              {!isArchitecture && selectedProgress.checked && (
                <div className="rb-checked" role="note">
                  <span className="rb-checked-label">
                    What was checked for this rating
                  </span>
                  <ul className="rb-checked-bullets">
                    {splitIntoBullets(selectedProgress.checked).map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                  <p className="rb-checked-hint">
                    Disagree with this rating? Challenge it with the review agent
                    — point at the code and it will re-evaluate. →
                  </p>
                </div>
              )}

              {selectedProgress.rationale.length > 0 && (
                <div className="rb-rationale">
                  <span className="rb-rationale-label">Verdict rationale</span>
                  <dl className="rb-rationale-list">
                    {selectedProgress.rationale.map((r, i) => (
                      <div key={i} className="rb-rationale-row">
                        <dt className="rb-rationale-term">{r.label}</dt>
                        <dd className="rb-rationale-detail">
                          <ul className="rb-rationale-bullets">
                            {splitIntoBullets(r.detail).map((b, j) => (
                              <li key={j}>{b}</li>
                            ))}
                          </ul>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {!isArchitecture && selectedProgress.checks.length > 0 && (
                <div className="rb-checks">
                  <span className="rb-checks-label">
                    What was analysed — line by line
                  </span>
                  <ul className="rb-checks-list">
                    {selectedProgress.checks.map((c, i) => (
                      <li
                        key={i}
                        className={`rb-check rb-check-${c.status}`}
                      >
                        <span
                          className="rb-check-status"
                          title={CHECK_STATUS_LABEL[c.status]}
                          aria-label={CHECK_STATUS_LABEL[c.status]}
                        >
                          {CHECK_STATUS_GLYPH[c.status]}
                        </span>
                        <span className="rb-check-body">
                          <span className="rb-check-item">{c.item}</span>
                          <span className="rb-check-finding">{c.finding}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {selectedProgress.status === 'skipped' && (
                <div className="rb-banner rb-banner-skip" role="note">
                  <strong>Skipped by the AI reviewer.</strong>{' '}
                  {selectedProgress.skipReason ??
                    'This perspective was judged not applicable to the change.'}
                </div>
              )}
              {selectedProgress.status === 'error' && (
                <div className="rb-banner rb-banner-err" role="alert">
                  <strong>Analysis failed.</strong>{' '}
                  {selectedProgress.error ??
                    'This perspective could not be analysed.'}{' '}
                  Automatic retries were exhausted.{' '}
                  <button
                    type="button"
                    className="rb-linkish"
                    onClick={() => void retryFailed()}
                  >
                    Retry failed
                  </button>
                </div>
              )}
              {selectedProgress.status === 'pending' && (
                <div className="rb-banner rb-banner-queued" role="status">
                  <strong>Queued for review.</strong> The AI reviewer works
                  through perspectives one at a time — this one is waiting its
                  turn. Existing findings stay visible until it runs.
                </div>
              )}
              {selectedProgress.status === 'retrying' && (
                <div className="rb-banner rb-banner-working" role="status">
                  <span className="spinner" aria-hidden="true" /> A transient
                  failure interrupted this perspective — automatically retrying
                  (attempt {selectedProgress.attempt} of 3) before reporting an
                  error.
                </div>
              )}
              {selectedProgress.status === 'analyzing' && (
                <div className="rb-banner rb-banner-working" role="status">
                  <span className="spinner" aria-hidden="true" /> The AI reviewer
                  is examining this perspective. Existing findings stay visible
                  while it works — remaining perspectives are queued and run one
                  by one.
                </div>
              )}
              {(selectedProgress.status === 'analyzing' ||
                selectedProgress.status === 'retrying') &&
                activityLines.length > 0 && (
                  <div className="rb-activity" role="log" aria-live="polite">
                    <span className="rb-activity-label">
                      Live analysis — what the reviewer is doing now
                    </span>
                    <ul className="rb-activity-list">
                      {activityLines.map((line, i) => (
                        <li key={i} className="rb-activity-line">
                          {line}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

              {selected.findings.length === 0 ? (
                <div className="rb-detail-empty">
                  <p className="rb-empty">
                    {selectedProgress.status === 'analyzing'
                      ? 'Looking for evidence-backed findings for this perspective…'
                      : selectedProgress.status === 'retrying'
                        ? 'Retrying after a transient failure…'
                        : selectedProgress.status === 'pending'
                          ? 'Queued — the reviewer will analyse this perspective shortly.'
                          : selectedProgress.status === 'skipped'
                            ? 'No findings — the reviewer skipped this perspective for the reason above.'
                            : selectedProgress.status === 'done'
                              ? selectedProgress.rationale.length > 0 ||
                                selectedProgress.checks.length > 0
                                ? 'No blocking findings. The rating above is backed by the verdict rationale and the line-by-line analysis — review them to see exactly what was inspected.'
                                : 'The AI reviewer raised no findings for this perspective — nothing here needs your attention.'
                              : 'Not analysed yet. Run the AI reviewer to author evidence-backed findings for this perspective.'}
                  </p>
                </div>
              ) : (
                <ul className="rb-findings">
                  {selected.findings.map((f) => {
                    const resolution = resolutionOf(resolutions, f.id);
                    const findingPath =
                      f.evidence
                        .map((e) => evidencePath(e.source))
                        .find((p): p is string => Boolean(p)) ?? null;
                    return (
                    <li
                      key={f.id}
                      className={`rb-finding rb-sev-${f.severity}${
                        resolution ? ` is-${resolution}` : ''
                      }`}
                    >
                      <div className="rb-finding-head">
                        <span className="rb-finding-title">{f.title}</span>
                        <span className={`rb-sev-tag rb-sev-tag-${f.severity}`}>
                          {f.severity}
                        </span>
                        <Marker kind="status" value={f.status} />
                        {resolution && (
                          <span className={`rb-finding-state rb-finding-${resolution}`}>
                            {resolution === 'resolved' ? 'Resolved' : 'Ignored'}
                          </span>
                        )}
                      </div>
                      <p className="rb-finding-detail">{f.detail}</p>
                      {f.evidence.length > 0 && (
                        <ul className="rb-evidence">
                          {f.evidence.map((e, i) => (
                            <li key={i}>
                              <EvidenceSource
                                source={e.source}
                                onOpenCodeReview={openEvidence}
                              />
                              <span className="rb-evidence-reason">
                                {e.reason}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="rb-finding-actions">
                        {findingPath && (
                          <button
                            type="button"
                            className="rb-finding-act rb-finding-act-diff"
                            onClick={() =>
                              openEvidence({ path: findingPath })
                            }
                            title={`Open ${findingPath} diff and comment inline`}
                          >
                            <PrReviewIcon size={13} /> Open diff
                          </button>
                        )}
                        {resolution ? (
                          <button
                            type="button"
                            className="rb-finding-act"
                            onClick={() => setFindingResolution(f.id, null)}
                          >
                            <RestoreIcon size={13} /> Reopen
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="rb-finding-act rb-finding-act-resolve"
                              onClick={() =>
                                setFindingResolution(f.id, 'resolved')
                              }
                              title="Mark this comment resolved"
                            >
                              <CheckIcon size={13} /> Resolve
                            </button>
                            <button
                              type="button"
                              className="rb-finding-act"
                              onClick={() =>
                                setFindingResolution(f.id, 'ignored')
                              }
                              title="Ignore this comment"
                            >
                              <CloseIcon size={13} /> Ignore
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
        </main>

        {agentOpen ? (
          <div
            className={`rb-agent-drawer${agentExpanded ? ' is-expanded' : ''}`}
          >
            <ReviewAgent
              featureId={featureId}
              pullNumber={board.pull.number}
              perspective={selected}
              focused={agentExpanded}
              onToggleFocus={() => setAgentExpanded((v) => !v)}
              onClose={() => setAgentOpen(false)}
              onRatingChange={(change) =>
                reviewBoardRunStore.applyRatingChange(featureId, change)
              }
            />
          </div>
        ) : (
          <button
            type="button"
            className="rb-agent-launcher"
            onClick={() => setAgentOpen(true)}
            title="Discuss the findings with the review agent"
          >
            <AiChatIcon size={18} />
            <span>Review agent</span>
          </button>
        )}

        <ExplainModel board={board} onOpenCodeReview={openEvidence} />
      </div>

      {diffTarget && (
        <div
          className="rb-diff-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Diff for ${diffTarget.path}`}
          onClick={() => setDiffTarget(null)}
        >
          <div
            className="rb-diff-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="rb-diff-modal-head">
              <div className="rb-diff-modal-titles">
                <span className="rb-diff-modal-label">Code diff — click a line to comment</span>
                <span className="rb-diff-modal-path">{diffTarget.path}</span>
              </div>
              <button
                type="button"
                className="rb-diff-modal-close"
                onClick={() => setDiffTarget(null)}
                aria-label="Close diff"
                title="Close"
              >
                <CloseIcon size={16} />
              </button>
            </header>
            <div className="rb-diff-modal-body">
              <CommentableDiff
                comments={comments}
                path={diffTarget.path}
                diff={diffTarget.diff}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Small expand/restore toggle used in each panel's header bar. */
function FocusToggle({
  active,
  label,
  onToggle,
}: {
  active: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="rb-focus-toggle"
      aria-pressed={active}
      title={active ? 'Restore layout' : `Expand ${label}`}
      aria-label={active ? 'Restore layout' : `Expand ${label}`}
      onClick={onToggle}
    >
      {active ? <RestoreIcon size={14} /> : <ExpandIcon size={14} />}
    </button>
  );
}
