import { useEffect, useMemo, useRef, useState, useCallback, useSyncExternalStore } from 'react';
import { ReviewDuration } from './review-duration.js';
import { ReviewContextSummary } from './review-context-summary.js';
import { Insights } from '../monitoring/insights.js';
import { ReviewInsights, reviewAttentionByPath } from './review-insights.js';
import { OperationInsights } from '../meta-operations/operation-insights.js';
import { useApi } from '../../app/api-context.js';
import { ApiError } from '../../lib/api.js';
import { Button, ConfirmDialog, ErrorText, Modal } from '../../components/ui.js';
import { useUsageStream } from '../../hooks/use-usage-stream.js';
import { useAgentUsage } from '../../hooks/use-agent-usage.js';
import { aggregateAgentUsage } from '../../lib/agent-usage.js';
import { AgentUsageValue } from '../../components/feature-agent-usage.js';
import { reviewBoardActivityLines } from '../../lib/stream.js';
import { parseFindingDetail } from '../../lib/finding-detail.js';
import { analysisFailureCause } from '../../lib/analysis-failure.js';
import {
  reviewBoardRunStore,
  type PerspectiveProgress,
} from './review-board-run-store.js';
import { ChangeGraph } from '../pr-review-page/change-graph.js';
import { usePrComments, CommentableDiff } from '../pr-review-page/pr-comments.js';
import {
  allPerspectivesReviewed,
  canCertifySignoff,
  isPerspectiveReviewed,
  perspectiveBadgeLabel,
  reviewedCount,
  signoffNoticeText,
  resolveSignoffIdentity,
} from '../../lib/review-signoff.js';
import {
  changeGraphDiffFiles,
  evidencePath,
  openFindingCount,
  resolutionOf,
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
  WarningIcon,
} from '../../components/icons.js';
import type {
  ChangeGraphStep,
  CheckStatus,
  DetectedItem,
  ReviewBoard,
  ReviewBoardChatMessage,
  ReviewBoardRatingChange,
  ReviewFinding,
  ReviewPerspective,
  ReviewRisk,
  ReviewStatus,
} from '../../lib/types.js';
import { PerspectivePromptPreview } from './perspective-prompt-preview.js';
import { FindingCommentDialog } from './finding-comment-dialog.js';
import { ReviewOverview, ReviewShortText } from './review-overview.js';
import { ReviewOptionsForm } from './review-options.js';
import { ReviewBusinessDetails, ReviewContextLoader } from './review-business-details.js';
import { useReviewLiveContext } from './use-review-live-context.js';
import { ReviewPublicationHistory } from './review-publication-history.js';
import { DeferredReviewNotice } from './deferred-review-notice.js';
import { findingCommentAnchors, type FindingCommentAnchor } from '../../lib/finding-comment.js';

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

interface ApprovalTarget {
  featureId: string;
  headSha: string;
  evidenceRevision: string;
  number: number;
  runId?: string;
  assessmentRevision?: number;
  signoffRevision?: string;
}

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

/** Section labels an AI finding uses; parsed out for clean, structured display. */
/** Renders a finding's detail as structured Problem / Where / Fix-verify blocks. */
function FindingDetail({ detail }: { detail: string }) {
  const sections = parseFindingDetail(detail);
  return (
    <div className="rb-finding-sections">
      {sections.map((s, i) => (
        <div key={i} className="rb-finding-section">
          {s.label && (
            <span
              className={`rb-finding-section-label rb-fs-${s.label
                .toLowerCase()
                .replace(/[^a-z]/g, '')}`}
            >
              {s.label}
            </span>
          )}
          <p className="rb-finding-section-body">{s.body}</p>
        </div>
      ))}
    </div>
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
  onRatingChange,
}: {
  featureId: string;
  pullNumber: number;
  perspective: ReviewPerspective | null;
  onRatingChange: (change: ReviewBoardRatingChange) => void;
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
        perspective
          ? {
              status: perspective.status,
              risk: perspective.risk,
              findings: perspective.findings,
            }
          : null,
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
      <p className="rb-agent-context">
        #{pullNumber} · {perspective?.name ?? 'Whole review'}
      </p>
      <div className="rb-agent-thread">
        {messages.length === 0 && !pending && (
          <p className="rb-agent-hint">
            Ask about a finding, the code, or a review decision.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`rb-agent-msg rb-agent-${m.role}`}>
            {m.content}
          </div>
        ))}
        {pending && <div className="rb-agent-msg rb-agent-assistant" role="status">Thinking…</div>}
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
          ariaLabel="Send message"
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
}: {
  featureId: string;
}) {
  const api = useApi();
  const loadRepositorySkills = useCallback((signal: AbortSignal) =>
    api.getReviewBoardSkills(featureId, signal), [api, featureId]);
  // The analysis run lives in a persistent, per-feature store so it keeps going
  // when the reviewer switches tabs/windows and this page unmounts — returning
  // shows live progress instead of restarting. The API adapter is memoised so
  // the store always drives the same stable client.
  const runApi = useMemo(
    () => ({
      getReviewBoard: api.getReviewBoard,
      configureReviewBoard: api.configureReviewBoard,
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
  const state = useSyncExternalStore(
    (listener) => reviewBoardRunStore.subscribe(featureId, listener),
    () => reviewBoardRunStore.getState(featureId),
  );
  const { board, loading, loadError: error, analyzed, progress, signoff, resolutions, prep } =
    state;
  const liveContext = useReviewLiveContext(featureId, board);
  const [reviewNow, setReviewNow] = useState(Date.now);
  const hasRunningClock = state.timing?.finishedAt === null || prep.active ||
    Object.values(progress).some((entry) => entry.timing?.finishedAt === null);
  useEffect(() => {
    if (!hasRunningClock) return;
    setReviewNow(Date.now());
    const timer = window.setInterval(() => setReviewNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningClock]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<ApprovalTarget | null>(null);
  const [approvedTarget, setApprovedTarget] = useState<ApprovalTarget | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const approvalLock = useRef(false);
  // A pending "Analyze with AI" click awaiting the take-latest confirmation.
  // `scope` is 'all' (whole board) or a perspective id (single perspective).
  const [pendingAnalyze, setPendingAnalyze] = useState<{ scope: string } | null>(
    null,
  );
  const [focus, setFocus] = useState<'nav' | 'canvas' | null>(null);
  // Lets the reviewer dismiss the "reviewing…" progress banner for the run.
  const [bannerHidden, setBannerHidden] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentPerspectiveId, setAgentPerspectiveId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [publicationHistoryOpen, setPublicationHistoryOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [businessContextDraft, setBusinessContextDraft] = useState<string | undefined>();
  const [optionsBusy, setOptionsBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dispositionTarget, setDispositionTarget] = useState<string | null>(null);
  const [dispositionReason, setDispositionReason] = useState('');
  useEffect(() => {
    setDetailsOpen(false);
    setAgentOpen(false);
    setAgentPerspectiveId(null);
    setPublicationHistoryOpen(false);
    setOptionsOpen(false);
    setBusinessContextDraft(undefined);
    setActionError(null);
    setPendingApproval(null);
  }, [featureId]);
  useEffect(() => {
    if (board && !board.perspectives.some((p) => p.id === selectedId)) {
      setSelectedId(board.perspectives[0]?.id ?? null);
    }
  }, [board, selectedId]);

  const load = useMemo(
    () => () => reviewBoardRunStore.load(featureId, runApi),
    [featureId, runApi],
  );
  const loadReviewContext = useCallback(async (signal: AbortSignal) => {
    const result = await api.loadReviewBoardContext(featureId, signal);
    await reviewBoardRunStore.load(featureId, runApi, true);
    return result;
  }, [api, featureId, runApi]);
  const analyze = useMemo(
    () => () => { setDetailsOpen(false); setPendingAnalyze({ scope: 'all' }); },
    [],
  );
  // Runs the analysis the reviewer just confirmed, optionally taking the latest
  // from the remote first (re-provision the PR worktree + rebuild the graph).
  const runPending = useMemo(
    () => (takeLatest: boolean) => {
      const pending = pendingAnalyze;
      setPendingAnalyze(null);
      if (pending) {
        void (async () => {
          setActionError(null);
          setBannerHidden(false);
          if (pending.scope === 'all' || (board?.run && board.run.status !== 'prepared')) {
            await reviewBoardRunStore.analyze(featureId, runApi, {
              takeLatest, fresh: Boolean(board?.run && (takeLatest || board.run.status !== 'prepared')),
              reviewOptions: board?.run?.options,
            });
          } else {
            await reviewBoardRunStore.analyzeOne(
              featureId,
              pending.scope,
              runApi,
              { takeLatest },
            );
          }
        })().catch((cause) => setActionError(cause instanceof Error ? cause.message : 'Could not start review.'));
      }
    },
    [featureId, runApi, pendingAnalyze, board, api],
  );
  const retryIncomplete = useMemo(
    () => () => board?.run && ['cancelled', 'interrupted'].includes(board.run.status)
      ? setPendingAnalyze({ scope: 'all' })
      : reviewBoardRunStore.retryFailed(featureId, runApi, { includeIncomplete: true }),
    [featureId, runApi, board?.run],
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

  useEffect(() => {
    if (!state.running && board?.run?.status !== 'running') return;
    const timer = window.setInterval(() => { void reviewBoardRunStore.refreshLive(featureId, runApi); }, 2000);
    return () => window.clearInterval(timer);
  }, [featureId, runApi, state.running, board?.run?.status]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      void reviewBoardRunStore.refreshLive(featureId, runApi);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [featureId, runApi]);

  // The change graph drives the Architecture & Code Flow perspective's code-flow
  // diagram (the same graph the PR "code review" renders). It lives on the PR
  // review, so fetch it here and refresh whenever the board is (re)generated —
  // e.g. after taking the latest — so the diagram tracks the code under review.
  const [changeGraph, setChangeGraph] = useState<ChangeGraphStep | null>(null);
  const [graphHeadSha, setGraphHeadSha] = useState<string | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graphAttempt, setGraphAttempt] = useState(0);
  // Live PR comment threads — lets reviewers comment directly on a line in the
  // focused code-flow diagram, exactly as they can on the PR code review page.
  const comments = usePrComments(featureId);
  const currentFeature = useRef(featureId);
  currentFeature.current = featureId;
  const [postTarget, setPostTarget] = useState<{
    featureId: string;
    finding: ReviewFinding;
    board: ReviewBoard;
    anchors: FindingCommentAnchor[];
    groupId?: string;
  } | null>(null);
  useEffect(() => { setPostTarget(null); }, [featureId]);
  const postingFindingIsCurrent = () => {
    if (!postTarget) return false;
    const live = reviewBoardRunStore.getState(postTarget.featureId);
    return !live.loading && !live.running && !live.prep.active &&
      live.board?.pull.headSha === postTarget.board.pull.headSha &&
      live.board?.reviewUpdatedAt === postTarget.board.reviewUpdatedAt &&
      live.board?.generatedAt === postTarget.board.generatedAt &&
      live.board?.run?.id === postTarget.board.run?.id &&
      live.board?.run?.revision === postTarget.board.run?.revision &&
      (live.board?.perspectives.some((p) => p.findings.some((f) => f.id === postTarget.finding.id)) === true ||
        live.board?.uniqueFindings?.some((group) => group.finding.id === postTarget.finding.id) === true) &&
      !live.resolutions[postTarget.finding.id];
  };
  // Clicking "Open diff" on a finding opens its referenced file diffs *inline*
  // here (focused, commentable, with the problem/fix framing) instead of
  // navigating to the full Code Review page. Per-file diffs come from the change
  // graph the page already loaded; we fall back to the full review only when no
  // diff is available for any referenced path.
  const [diffTarget, setDiffTarget] = useState<{
    title: string;
    detail: string | null;
    files: { path: string; diff: string }[];
    allFiles?: boolean;
    focus?: { path: string; line: number } | null;
  } | null>(null);
  useEffect(() => { setDiffTarget(null); }, [featureId]);
  const resolveNodeDiff = useCallback(
    (path: string): { path: string; diff: string } | null => {
      if (!changeGraph) return null;
      const base = path.split(/[\\/]/).pop() ?? path;
      const match =
        changeGraph.nodes.find((n) => n.path === path && n.diff) ??
        changeGraph.nodes.find(
          (n) => n.diff && (n.path.endsWith(path) || n.path.endsWith(base)),
        );
      return match ? { path: match.path, diff: match.diff } : null;
    },
    [changeGraph],
  );
  const openEvidence = useCallback(
    (target?: CodeReviewTarget) => {
      const path = target?.path;
      if (path) {
        setDetailsOpen(false);
        const file = resolveNodeDiff(path);
        if (file) {
          setDiffTarget({ title: file.path, detail: null, files: [file] });
          return;
        }
        // No diff captured for this path in the change graph — still open the
        // modal so the reviewer sees which file is referenced instead of a
        // dead click. (The Code Review page has been retired.)
        setDiffTarget({ title: path, detail: null, files: [] });
        return;
      }
      // No file path (e.g. the evidence source is literally "change graph"):
      // take the reviewer to the change-graph diagram instead of dead-clicking.
      // Prefer the Architecture perspective (which renders the diagram); if the
      // board has no such perspective, fall back to a whole-change diff modal
      // built from every graph node that captured a diff.
      const hasArchitecture = board?.perspectives.some(
        (p) => p.id === 'architecture',
      );
      if (hasArchitecture) {
        setSelectedId('architecture');
        setDetailsOpen(true);
        return;
      }
      const files = changeGraphDiffFiles(changeGraph?.nodes ?? []);
      setDetailsOpen(false);
      setDiffTarget({ title: 'Change graph', detail: null, files });
    },
    [resolveNodeDiff, board, changeGraph],
  );
  const openFindingDiff = useCallback(
    (finding: ReviewFinding) => {
      setDetailsOpen(false);
      // Gather every distinct file the finding cites, in evidence order, and
      // resolve each to its diff from the change graph.
      const seen = new Set<string>();
      const files: { path: string; diff: string }[] = [];
      for (const e of finding.evidence) {
        const p = evidencePath(e.source);
        if (!p) continue;
        const file = resolveNodeDiff(p);
        if (file && !seen.has(file.path)) {
          seen.add(file.path);
          files.push(file);
        }
      }
      // Prefer the agent's exact RIGHT-side coordinate so the diff opens scrolled
      // to (and highlighting) the line the finding is about, not just the top of
      // the file. Only right-side lines have a position in the rendered diff.
      let focus: { path: string; line: number } | null = null;
      for (const e of finding.evidence) {
        if (!e.location || e.location.side !== 'RIGHT') continue;
        const file = resolveNodeDiff(e.location.path);
        if (file) {
          focus = { path: file.path, line: e.location.line };
          break;
        }
      }
      // Even when no per-file diff is available, open the modal with the
      // finding's problem/fix framing so clicking "Open diff" always surfaces
      // context inline. (The dedicated Code Review page has been retired.)
      setDiffTarget({
        title: finding.title,
        detail: finding.detail,
        files,
        focus,
      });
    },
    [resolveNodeDiff],
  );
  useEffect(() => {
    let cancelled = false;
    if (!board) {
      setChangeGraph(null);
      setGraphHeadSha(null);
      setGraphLoading(false);
      setGraphError(null);
      return;
    }
    setGraphLoading(true);
    setGraphError(null);
    setChangeGraph(null);
    setGraphHeadSha(null);
    void runApi
      .getPrReview(featureId)
      .then((review) => {
        if (!cancelled) {
          setChangeGraph(review.changeGraph);
          setGraphHeadSha(review.headSha);
        }
      })
      .catch((error) => {
        if (!cancelled) setGraphError(error instanceof Error ? error.message : 'Could not load changed files.');
      })
      .finally(() => { if (!cancelled) setGraphLoading(false); });
    return () => {
      cancelled = true;
    };
  }, [featureId, runApi, board?.generatedAt, graphAttempt]);
  const changedFiles = useMemo(() => (changeGraph?.nodes ?? [])
    .filter((node) => node.kind === 'changed')
    .map((node) => ({ path: node.path, diff: node.diff }))
    .sort((a, b) => a.path.localeCompare(b.path)), [changeGraph]);
  const visibleDiffFiles = diffTarget?.allFiles ? changedFiles : diffTarget?.files ?? [];

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
  const agentUsage = useAgentUsage(featureId, 'Review board', undefined, live);
  const activityLines = selectedId
    ? reviewBoardActivityLines(live, featureId, selectedId)
    : [];
  const analyzing =
    state.running || prep.active || board?.run?.status === 'running' ||
    progressValues.some(
      (p) =>
        p.status === 'analyzing' ||
        p.status === 'pending' ||
        p.status === 'retrying',
    );
  // Perspectives the reviewer has actually picked up — done, skipped, errored,
  // or currently in flight. Excludes those still queued as `pending` so the
  // "Reviewing N of M" progress reflects real activity (with parallel runs more
  // than one is in flight at once), not just the completed count.
  const reviewingCount = progressValues.filter(
    (p) => p.status !== 'pending',
  ).length;
  const failedCount = progressValues.filter(
    (p) => p.status === 'error',
  ).length;
  const failureCause = analysisFailureCause(
    progressValues.filter((p) => p.status === 'error').map((p) => p.error),
  );
  const totalPerspectives = board?.perspectives.length ?? 0;
  const finishedCount = board?.perspectives.filter((p) =>
    ['done', 'skipped', 'error'].includes(progress[p.id]?.status ?? '')).length ?? 0;
  const activeCount = board?.perspectives.filter((p) =>
    ['analyzing', 'retrying'].includes(progress[p.id]?.status ?? '')).length ?? 0;
  const finishedPercent = totalPerspectives ? finishedCount / totalPerspectives * 100 : 0;

  const perspectiveIds = board?.perspectives.map((p) => p.id) ?? [];
  const reviewedN = reviewedCount(signoff, perspectiveIds);
  const missingBusinessContext = Boolean(board?.run?.perspectiveIds.includes('business') &&
    !board.run.context.businessRequirements.trim() &&
    !board.run.context.requirements?.some((requirement) => requirement.priority < 100));
  const incompleteBusinessMatrix = Boolean(board?.run?.perspectiveIds.includes('business') &&
    board.businessMatrix?.some((row) => row.assessment === 'ambiguous' || row.assessment === 'not-assessed'));
  const canSignoff = canCertifySignoff(signoff) && (!board?.run ||
    (!missingBusinessContext && !incompleteBusinessMatrix && board.run.status === 'completed' && board.run.perspectiveIds.every((id) =>
      board.analyses?.[id]?.runId === board.run?.id &&
      board.analyses?.[id]?.assessment !== 'insufficient-evidence')));
  const signoffNotice = signoffNoticeText(signoff);

  // Roll-up counts that reflect the reviewer's live resolve/ignore decisions —
  // resolved or ignored findings drop out of the open/blocking/warning/suggestion
  // totals immediately, so the header tracks the perspective list live.
  const liveSummary = useMemo(() => {
    let open = 0;
    let blocking = 0;
    let warnings = 0;
    let suggestions = 0;
    const findings = board?.uniqueFindings
      ? board.uniqueFindings.filter((group) => (group.disposition ?? 'open') === 'open').map((group) => group.finding)
      : (board?.perspectives ?? []).flatMap((perspective) => perspective.findings).filter((finding) => !resolutionOf(resolutions, finding.id));
      for (const f of findings) {
        open += 1;
        if (f.severity === 'critical' || f.severity === 'high') blocking += 1;
        else if (f.severity === 'suggestion') suggestions += 1;
        else warnings += 1;
    }
    return { open, blocking, warnings, suggestions };
  }, [board?.perspectives, board?.uniqueFindings, resolutions]);
  const publicationStates = useMemo(() => {
    const result = { ...state.publications };
    for (const group of board?.uniqueFindings ?? []) {
      const matches = liveContext.publications.filter((record) => record.input.expectedRunId === board?.run?.id &&
        [group.id, group.finding.id, ...group.observations.map((observation) => observation.id)].some((id) =>
          record.input.publicationKey?.startsWith(`${JSON.stringify([board?.run?.id, id]).slice(0, -1)},`)));
      const status = matches.some((record) => record.status === 'uncertain') ? 'uncertain'
        : matches.some((record) => record.status === 'pending') ? 'pending' : matches.length ? 'posted' : undefined;
      if (status) result[group.finding.id] = status;
    }
    return result;
  }, [board?.uniqueFindings, board?.run?.id, liveContext.publications, state.publications]);
  const allReviewed = allPerspectivesReviewed(signoff, perspectiveIds);
  const reviewComplete = Boolean(board && analyzed && !analyzing && !state.queued && !missingBusinessContext && !incompleteBusinessMatrix &&
    perspectiveIds.length > 0 && board.perspectives.every((perspective) =>
      (progress[perspective.id]?.status === 'done' || board.analyses?.[perspective.id]?.assessment === 'not-applicable') &&
      perspective.status !== 'not-started' &&
      board.analyses?.[perspective.id]?.assessment !== 'insufficient-evidence') &&
    (!board.run || (board.run.status === 'completed' && board.run.perspectiveIds.every((id) =>
      board.analyses?.[id]?.runId === board.run?.id))));
  const approved = approvedTarget?.featureId === featureId &&
    approvedTarget.headSha === board?.pull.headSha &&
    approvedTarget.runId === board?.run?.id &&
    approvedTarget.signoffRevision === resolveSignoffIdentity(board!)?.assessmentRevision;
  const canApprove = reviewComplete && canSignoff && !loading && !error &&
    liveSummary.blocking === 0 && !approvalBusy && !approved;
  const approvalUnavailable = !canSignoff || loading || error
    ? 'Verify the reviewed commit before approving'
    : liveSummary.blocking > 0 ? 'Resolve blocking findings before approving'
      : 'Approve this pull request on its Git provider';

  async function confirmApproval() {
    const target = pendingApproval;
    if (!target || approvalLock.current) return;
    if (!board || !canApprove || target.featureId !== featureId ||
        target.headSha !== board?.pull.headSha ||
        target.evidenceRevision !== board.reviewUpdatedAt ||
        target.runId !== board.run?.id ||
        target.signoffRevision !== resolveSignoffIdentity(board)?.assessmentRevision) {
      setApprovalError('The review changed. Close this dialog and verify the latest results.');
      return;
    }
    approvalLock.current = true;
    setApprovalBusy(true);
    setApprovalError(null);
    try {
      await api.approvePrReview(target.featureId, {
        expectedHeadSha: target.headSha,
        ...(target.runId ? { expectedRunId: target.runId } : {}),
        ...(target.assessmentRevision !== undefined ? { expectedAssessmentRevision: target.assessmentRevision } : {}),
      });
      setApprovedTarget(target);
      setPendingApproval((current) => current === target ? null : current);
    } catch (cause) {
      setApprovalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      approvalLock.current = false;
      setApprovalBusy(false);
    }
  }
  const prReviewed = signoff.prReviewedAt !== null;
  const selectedReviewed = selectedId
    ? isPerspectiveReviewed(signoff, selectedId)
    : false;
  const selectedAnalyzing =
    selectedProgress.status === 'analyzing' ||
    selectedProgress.status === 'retrying' ||
    selectedProgress.status === 'pending';
  // Live open-finding count / verdict for the selected perspective, reflecting
  // the reviewer's resolve/ignore decisions (mirrors the nav list roll-up).
  const selectedOpen = selected
    ? board?.uniqueFindings ? board.uniqueFindings.filter((group) => group.perspectiveIds.includes(selected.id) &&
      (group.disposition ?? 'open') === 'open').length : openFindingCount(
        resolutions,
        selected.findings.map((f) => f.id),
      )
    : 0;
  const selectedAssessment = selectedId ? board?.analyses?.[selectedId]?.assessment : undefined;
  const selectedClean =
    selectedProgress.status === 'done' && selectedOpen === 0 &&
    selectedAssessment !== 'insufficient-evidence' && selectedAssessment !== 'concerns';
  const selectedStatus =
    selected && selectedClean ? 'approved' : selected?.status;

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

  if (!board && (loading || state.queued || prep.active)) {
    return (
      <div className="rb-page rb-state" role="status">
        <span className="spinner" aria-hidden="true" />
        {state.queued ? 'Queued for review' : prep.active ? prep.message : 'Loading review board…'}
      </div>
    );
  }

  if ((error || prep.error) && !board) {
    return (
      <div className="rb-page rb-state">
        <DeferredReviewNotice key={featureId} featureId={featureId} error={error ?? prep.error}
          onReady={load} onRetry={() => void load()} />
      </div>
    );
  }

  if (!board) return null;

  const needsLatestEvidence = Boolean(prep.error && /remote head|target changed|review evidence changed/i.test(prep.error));
  const reviewFailed = failedCount > 0 && !analyzing;
  const pendingPublications = liveContext.publications.some((record) => record.status !== 'posted');
  const statusErrors = [...new Set([prep.error, error, actionError].filter((message): message is string => Boolean(message)))];
  const statusError = statusErrors[0];
  const needsAttention = statusError || reviewFailed ||
    liveContext.publicationsError || pendingPublications;

  return (
    <div className="rb-page">
      <header className="rb-header">
        <div className="rb-header-main">
          <h2 className="rb-title">
            <PrReviewIcon size={18} /> Review Board
          </h2>
          <p className="rb-subtitle">
            <a
              className="rb-pr-link"
              href={board.pull.url}
              target="_blank"
              rel="noreferrer"
              title={`Open PR #${board.pull.number} in the browser`}
            >
              #{board.pull.number} · {board.pull.title}
            </a>
            {board.pull.headSha ? (
              <span
                className="rb-commit"
                title={`Reviewing commit ${board.pull.headSha}`}
              >
                @ {board.pull.headSha.slice(0, 8)}
              </span>
            ) : null}
          </p>
          {signoffNotice && (
            <p className="rb-subtitle" role="alert">
              {signoffNotice}
            </p>
          )}
        </div>
        <div className="rb-header-side">
          <span
            className={`rb-reco rb-reco-${
              analyzing
                ? 'reviewing'
                : reviewComplete ? 'approve' : 'needs-review'
            }`}
          >
            {prep.active ? 'Preparing review' : analyzing
              ? `Reviewing ${reviewingCount}/${totalPerspectives}`
              : board.run && ['failed', 'cancelled', 'interrupted'].includes(board.run.status)
                ? `Review ${board.run.status}`
                : board.run && !board.run.perspectiveIds.includes('business')
                  ? reviewComplete ? 'Code-only review complete' : 'Code-only review incomplete'
                  : reviewComplete ? 'Review complete' : 'Review incomplete'}
          </span>
          <button type="button" className="rb-act" aria-label="Run details and perspectives"
            aria-haspopup="dialog" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(true)}>Details</button>
          {reviewComplete ? (
            <button
              type="button"
              className="rb-act rb-act-success"
              disabled={!canApprove}
              title={approved ? 'Approval submitted to the Git provider' : approvalUnavailable}
              onClick={() => {
                if (!board.pull.headSha) return;
                setApprovalError(null);
                setPendingApproval({
                  featureId, headSha: board.pull.headSha,
                  evidenceRevision: board.reviewUpdatedAt, number: board.pull.number,
                  runId: board.run?.id, assessmentRevision: board.run?.revision,
                  signoffRevision: resolveSignoffIdentity(board)?.assessmentRevision,
                });
              }}
            >
              {approvalBusy ? <span className="spinner" aria-hidden="true" /> : <CheckIcon size={15} />}
              <span className="rb-act-label">{approved ? 'Approved' : approvalBusy ? 'Approving…' : 'Approve PR'}</span>
            </button>
          ) : needsLatestEvidence ? null : <button
            type="button"
            className="rb-act rb-act-primary"
            onClick={() => analyzed ? void retryIncomplete() : void analyze()}
            disabled={analyzing || state.queued}
            title={
              prep.active ? 'Preparing review context…' : analyzing
                ? 'Reviewing…'
                : analyzed
                  ? 'Resume this saved review and recompute its final decision; use New review to capture fresh context'
                  : 'Start Review'
            }
            aria-label={prep.active ? 'Preparing review' : analyzing ? 'Reviewing' : analyzed ? 'Retry incomplete review' : 'Start Review'}
          >
            {analyzing ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <AiMagicIcon size={15} />
            )}
            <span className="rb-act-label">
              {state.queued ? 'Queued for review' : prep.active ? 'Preparing…' : analyzing ? 'Reviewing…' : analyzed ? 'Retry review' : 'Start review'}
            </span>
          </button>}
          <details className="rb-header-menu"><summary className="rb-act" aria-label="More review actions">More</summary>
            <div className="rb-header-menu-items">
              <button type="button" className="rb-act" aria-label="Review options" aria-haspopup="dialog"
                aria-expanded={optionsOpen} disabled={analyzing || state.queued || optionsBusy} onClick={(event) => {
                  event.currentTarget.closest('details')?.removeAttribute('open');
                  setBusinessContextDraft(undefined); setOptionsOpen(true);
                }}>Review settings</button>
              {board.run && board.run.status !== 'prepared' && !analyzing && <button type="button" className="rb-act" onClick={(event) => {
                event.currentTarget.closest('details')?.removeAttribute('open'); void analyze();
              }} disabled={optionsBusy || state.queued}>Start a new review</button>}
            </div>
          </details>
          {(analyzing || state.queued || board.run?.status === 'running') && <button type="button" className="rb-act"
            disabled={optionsBusy} onClick={() => {
              setOptionsBusy(true);
              void api.cancelReviewBoard(featureId).then(() => reset()).catch((cause) =>
                setActionError(cause instanceof Error ? cause.message : 'Could not cancel review.'))
                .finally(() => setOptionsBusy(false));
            }}>Cancel review</button>}
        </div>
      </header>

      {needsAttention && <section
        className={`rb-review-status${statusError || reviewFailed ? ' rb-review-status-error' : ''}`}
        aria-label="Review status"
      >
        <div className="rb-status-heading" role={statusError || reviewFailed ? 'alert' : undefined}>
          <WarningIcon size={20} />
          <div className="rb-status-copy">
            <h3>{needsLatestEvidence ? 'Review needs fresh evidence'
              : statusError || reviewFailed ? 'Review could not complete'
                : 'Check PR comment delivery'}</h3>
            {statusErrors.map((message) => <ErrorText key={message} error={message} />)}
            {!statusError && reviewFailed && <p>Some perspectives did not return a completed result. Approval remains unavailable.</p>}
            {!statusError && !reviewFailed && <p>Check whether the comment reached the PR before posting it again.</p>}
          </div>
          <div className="rb-status-actions">
            {needsLatestEvidence && <Button
              variant="primary"
              disabled={analyzing || state.queued}
              onClick={() => {
                setActionError(null);
                setBannerHidden(false);
                void reviewBoardRunStore.analyze(featureId, runApi, {
                  takeLatest: true, fresh: true, reviewOptions: board.run?.options,
                }).catch((cause) => setActionError(cause instanceof Error ? cause.message : 'Could not start review.'));
              }}
            ><RefreshIcon size={14} /> Take latest &amp; retry</Button>}
            {prep.error && <Button variant="ghost" onClick={() => reviewBoardRunStore.clearPrepError(featureId)}>
              <CloseIcon size={14} /> Dismiss
            </Button>}
          </div>
        </div>
        <div className="rb-status-body">
          {reviewFailed && <div className="rb-status-item">
            <strong>Incomplete perspectives</strong>
            <p>{`${failedCount} perspective${failedCount === 1 ? '' : 's'} couldn't be analysed. No completed result was received; this is not a clean review.`}</p>
            {failureCause && <details className="rb-status-details"><summary>Technical details</summary><ErrorText error={failureCause} /></details>}
          </div>}
          {(liveContext.publicationsError || pendingPublications) && <div className="rb-status-item">
            <strong>PR comment status</strong>
            {liveContext.publicationsError && <p role="alert">
              Publication history unavailable. Check the PR before posting. <button type="button" className="rb-linkish" onClick={liveContext.refresh}><RefreshIcon size={13} /> Retry publication history</button>
            </p>}
            {pendingPublications && <p>
              Some PR comment publications are pending or uncertain.{' '}
              <button type="button" className="rb-linkish" aria-haspopup="dialog" aria-expanded={publicationHistoryOpen}
                onClick={() => setPublicationHistoryOpen(true)}>Review publication recovery</button>
            </p>}
          </div>}
        </div>
      </section>}
      {publicationHistoryOpen && <ReviewPublicationHistory featureId={featureId} pullUrl={board.pull.url}
        records={liveContext.publications} onUpdate={liveContext.updatePublication} onClose={() => setPublicationHistoryOpen(false)} />}
      {optionsOpen && <Modal title="Review options" size="lg" onClose={() => setOptionsOpen(false)}>
        <ReviewOptionsForm board={board} busy={optionsBusy} businessContextDraft={businessContextDraft} onPrepare={async (options) => {
          setOptionsBusy(true);
          try {
            await api.configureReviewBoard(featureId, options);
            await reviewBoardRunStore.load(featureId, runApi, true);
            setOptionsOpen(false);
          } finally { setOptionsBusy(false); }
        }} />
      </Modal>}
      {pendingApproval?.featureId === featureId && (
        <ConfirmDialog
          title={`Approve PR #${pendingApproval.number}?`}
          confirmLabel="Submit approval"
          danger={false}
          busy={approvalBusy}
          error={approvalError}
          message={<>
            <p>Submit your approval for commit <strong>{pendingApproval.headSha.slice(0, 8)}</strong> to the Git provider.</p>
            {liveSummary.open > 0 && <p>{liveSummary.open} non-blocking finding(s) remain open.</p>}
          </>}
          onCancel={() => { setPendingApproval(null); setApprovalError(null); }}
          onConfirm={() => void confirmApproval()}
        />
      )}

      {analyzing && !prep.active && !bannerHidden && (
        <div className="rb-analyzing rb-analyzing-live" role="status">
          <div className="rb-analysis-heading">
            <span className="spinner" aria-hidden="true" />
            <span>
              Reviewing {reviewingCount} of {totalPerspectives} perspectives.
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
          <div className="rb-analysis-caption">
            <span>{finishedCount} / {totalPerspectives} finished · {activeCount} active</span>
            <span>Results appear below as checks finish.</span>
          </div>
          <div className="rb-analysis-track" role="progressbar" aria-label="Review progress"
            aria-valuemin={0} aria-valuemax={totalPerspectives || 1} aria-valuenow={finishedCount}
            aria-valuetext={`${finishedCount} of ${totalPerspectives} checks finished; ${activeCount} active`}>
            <span className="rb-analysis-fill" style={{ width: `${finishedPercent}%` }} />
            <span className="rb-analysis-activity" aria-hidden="true" style={{ left: `${finishedPercent}%` }} />
          </div>
        </div>
      )}

      {prep.active && (
        <div className="rb-analyzing" role="status">
          <progress className="rb-preparation-progress" aria-label="Preparing review" />
          <span>{prep.message}</span>
        </div>
      )}

      {pendingAnalyze && (
        <Modal title="Start Review" onClose={() => setPendingAnalyze(null)}>
          <div
            className="rb-confirm-content"
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
        </Modal>
      )}

      <ReviewOverview board={board} complete={reviewComplete} running={analyzing || state.queued}
        loadContext={loadReviewContext}
        loadRepositorySkills={loadRepositorySkills}
        resolutions={resolutions} publications={publicationStates} resolutionReasons={state.resolutionReasons}
        discussion={liveContext.discussion} onRefreshDiscussion={liveContext.refresh}
        onReviewDetails={() => setDetailsOpen(true)}
        onEvidence={(entry) => openEvidence({ path: entry.location?.path ?? evidencePath(entry.source) ?? undefined })}
        onManage={board.run ? async (input) => {
          await api.manageReviewBoardFindings(featureId, input);
          await reviewBoardRunStore.load(featureId, runApi);
        } : undefined}
        onDiff={(finding) => { setDetailsOpen(false); openFindingDiff(finding); }}
        onPost={(finding, groupId) => setPostTarget({
          featureId, finding, board, groupId,
          anchors: changeGraph?.status === 'ready' && graphHeadSha === board.pull.headSha
            ? findingCommentAnchors(finding, changeGraph.nodes) : [],
        })}
        onDisposition={(ids, disposition, reason) => ids.forEach((id) =>
          reviewBoardRunStore.setFindingResolution(featureId, id, disposition, reason))}
      />
      <button type="button" className="rb-agent-launcher" onClick={() => { setAgentPerspectiveId(null); setAgentOpen(true); }}>
        <AiChatIcon size={18} /><span>Review agent</span>
      </button>
      {agentOpen && <Modal title="Review agent" size="lg" className="rb-agent-dialog" onClose={() => setAgentOpen(false)}>
        <ReviewAgent
          featureId={featureId}
          pullNumber={board.pull.number}
          perspective={board.perspectives.find((entry) => entry.id === agentPerspectiveId) ?? null}
          onRatingChange={(change) => reviewBoardRunStore.applyRatingChange(featureId, change)}
        />
      </Modal>}
      {detailsOpen && <Modal title="Run details and perspectives" size="full" className="rb-details-dialog" onClose={() => setDetailsOpen(false)}>
      <details className="rb-context-disclosure rb-run-information">
      <summary>Run information</summary>
      <Insights title="Review monitoring">{() => <>
        <ReviewInsights key={board.run?.id ?? featureId} board={board} />
        {board.run && <OperationInsights scope={{ featureId, runId: board.run.id }} signal={`${board.run.status}:${board.perspectives.map((perspective) => perspective.status).join(',')}`} />}
      </>}</Insights>
      {board.run ? <section className="rb-run-snapshot">
        <h3>{board.run.status === 'failed' ? 'The review did not finish' : board.run.status === 'completed' ? 'Analysis finished' : `Review ${board.run.status}`}</h3>
        <p>{Object.keys(board.analyses ?? {}).length} of {totalPerspectives} perspectives returned results. Select a perspective below to see what was checked, its findings, or why it failed.</p>
        {Object.keys(board.run.failures).length > 0 && <div className="rb-run-failures">
          {Object.entries(board.run.failures).map(([id, message]) => <button key={id} type="button" className="rb-run-failure"
            onClick={() => setSelectedId(id)}>
            <strong>{board.perspectives.find((perspective) => perspective.id === id)?.name ?? id}</strong>
            <span>{/invalid.*JSON|expected valid JSON/i.test(message) ? 'No readable review response'
              : /cit|identit|location|Finding must/i.test(message) ? 'Response could not be matched to the captured evidence'
                : 'Analysis could not complete'}</span>
          </button>)}
        </div>}
        <details className="rb-context-disclosure"><summary>Technical run information and collection notes</summary>
        <p>Run {board.run.id} · revision {board.run.revision} · {board.run.status}</p>
        <p>Provider: {board.run.providerId} · model: {board.run.model}
          {board.run.model === 'auto' ? ' (provider-selected; actual model may vary by attempt)' : ''}</p>
        <p>Started: {board.run.startedAt}{board.run.finishedAt ? ` · finished: ${board.run.finishedAt}` : ''}</p>
        <p>Context: {board.run.context.fingerprint} · base: {board.run.context.baseSha || 'unavailable'} · merge base: {board.run.context.mergeBaseSha || 'unavailable'}</p>
        <ul>{board.run.context.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        <ul>{Object.entries(board.run.failures).map(([id, message]) => <li key={id}>{id}: {message}</li>)}</ul>
        </details>
      </section> : <p>Legacy review: model, skills and immutable run provenance are unavailable. Start a new review to capture them.</p>}
      <div className="rb-summary">
        <span title="Vendor-reported Review Board AIC across this feature's persisted review history, including retries. Not limited to the latest timed attempt.">
          Review history: <AgentUsageValue usage={agentUsage} />
        </span>
        <ReviewDuration timing={state.timing} now={reviewNow} label="Full review" />
        <ReviewDuration timing={state.preparationTiming} now={reviewNow} label="Evidence preparation" />
        <span>
          <strong>{liveSummary.open}</strong> open
        </span>
        <span>
          <strong>{liveSummary.blocking}</strong> blocking
        </span>
        <span>
          <strong>{liveSummary.warnings}</strong> warnings
        </span>
        <span>
          <strong>{liveSummary.suggestions}</strong> suggestions
        </span>
        <ReviewContextSummary board={board} graph={changeGraph} loading={graphLoading} error={graphError}
          onOpenFiles={() => { setDetailsOpen(false); setDiffTarget({ title: 'Changed files', detail: null, files: [], allFiles: true }); }} />
      </div>
      </details>
      <div className="rb-details-actions">
        <span>{reviewedN}/{totalPerspectives} reviewed</span>
        {prReviewed ? <Button onClick={clearPrReviewed}>Re-open PR</Button>
          : <Button onClick={() => markPrReviewed(perspectiveIds)} disabled={!allReviewed || !canSignoff}>Mark PR reviewed</Button>}
        {!board.run && <Button onClick={() => reset()}>{analyzing ? 'Stop & reset' : 'Reset'}</Button>}
        <Button variant="ghost" onClick={() => {
          setAgentPerspectiveId(selected?.id ?? null);
          setDetailsOpen(false);
          setAgentOpen(true);
        }}>Ask about this perspective</Button>
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
            // Reflect the reviewer's resolve/ignore decisions live: once every
            // finding is resolved/ignored (or there were none), the perspective
            // reads as clean/approved and the open-count badge disappears.
            const navOpen = board.uniqueFindings ? board.uniqueFindings.filter((group) => group.perspectiveIds.includes(p.id) &&
              (group.disposition ?? 'open') === 'open').length : openFindingCount(
              resolutions,
              p.findings.map((f) => f.id),
            );
            const assessment = board.analyses?.[p.id]?.assessment;
            const navClean = state === 'done' && navOpen === 0 &&
              assessment !== 'insufficient-evidence' && assessment !== 'concerns';
            const navStatus = navClean ? 'approved' : p.status;
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
                  {state === 'done' && navClean && (
                    <CheckIcon
                      size={13}
                      className="rb-nav-ico rb-nav-clean-ico"
                    />
                  )}
                  <span
                    className={`rb-dot ${
                      navAnalyzing ? 'rb-dot-reviewing' : `rb-status-${navStatus}`
                    }`}
                    title={perspectiveBadgeLabel(navAnalyzing, navStatus)}
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
                  {navOpen > 0 && (
                    <span className="rb-nav-count">{navOpen}</span>
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
                    selectedAnalyzing ? 'reviewing' : selectedStatus
                  }`}
                >
                  {perspectiveBadgeLabel(selectedAnalyzing, selectedStatus ?? selected.status)}
                </span>
                <button
                  type="button"
                  className="rb-act rb-act-icon"
                  onClick={analyze}
                  disabled={analyzing || state.queued}
                  title="Start a fresh full review using the saved options"
                  aria-label="Start a fresh full review"
                >
                  <AiMagicIcon size={14} />
                </button>
                <PerspectivePromptPreview
                  perspectiveId={selected.id}
                  perspectiveName={selected.name}
                />
                <button
                  type="button"
                  className={`rb-act rb-act-icon ${
                    selectedReviewed ? 'rb-act-success' : 'rb-act-primary'
                  }`}
                  onClick={() =>
                    setPerspectiveReviewed(selected.id, !selectedReviewed)
                  }
                  disabled={
                    selectedAnalyzing ||
                    (!canSignoff && !selectedReviewed)
                  }
                  title={
                    !canSignoff && !selectedReviewed
                      ? 'Review sign-off is unavailable until the reviewed commit identity is known'
                      : selectedReviewed
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
              {selectedAssessment === 'insufficient-evidence' && <p>Assessment: insufficient evidence</p>}
              {selected.id === 'business' && <details className="rb-context-disclosure"><summary>Acceptance criteria and source evidence</summary>
                <ReviewContextLoader board={board} running={analyzing || state.queued}
                loadContext={loadReviewContext} />
                <ReviewBusinessDetails board={board}
                onEvidence={(entry) => openEvidence({ path: entry.location?.path ?? evidencePath(entry.source) ?? undefined })}
                onFinding={(id) => {
                  const finding = board.perspectives.flatMap((perspective) => perspective.findings).find((entry) => entry.id === id);
                  if (finding) openFindingDiff(finding);
                }} /></details>}
              <div className="rb-detail-meta">
                <span>
                  <strong>{selectedOpen}</strong> open
                  {selectedOpen !== selected.findings.length && (
                    <> · {selected.findings.length} total</>
                  )}{' '}
                  finding{selected.findings.length === 1 ? '' : 's'}
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

              {isArchitecture && <details className="rb-context-disclosure"><summary>Code flow</summary>
                {
                (changeGraph && changeGraph.nodes.length > 0 ? (
                  <div className="rb-codeflow">
                    <span className="rb-codeflow-label">
                      Code flow — how the changed files connect
                    </span>
                    <div className="rb-codeflow-graph">
                      <ChangeGraph
                        step={changeGraph}
                        concerns={graphHeadSha === board.pull.headSha && (!board.run || board.run.graphGeneratedAt === changeGraph.generatedAt)
                          ? reviewAttentionByPath(board) : undefined}
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
                ))}</details>}

              {!isArchitecture && selectedProgress.checked && (
                <div className="rb-checked" role="note">
                  <span className="rb-checked-label">
                    What was checked for this rating
                  </span>
                  <ReviewShortText text={selectedProgress.checked} />
                </div>
              )}

              <details key={selected.id} className="rb-context-disclosure">
                <summary>Assessment evidence</summary>
                <p className="rb-detail-why">{selected.why}</p>
                {selectedAssessment && <p>Assessment: {selectedAssessment.replaceAll('-', ' ')}</p>}
                <Marker kind="risk" value={selected.risk} />
                <ReviewDuration timing={progress[selected.id]?.timing} now={reviewNow} label="Time" />
                <span title="Vendor AIC attributed to this perspective across review history">
                  <AgentUsageValue usage={{
                    ...aggregateAgentUsage(agentUsage.snapshots, 'Review board', selected.id),
                    loading: agentUsage.loading, error: agentUsage.error,
                  }} />
                </span>
              {selectedProgress.rationale.length > 0 && (
                <div className="rb-rationale">
                  <span className="rb-rationale-label">Verdict rationale</span>
                  <dl className="rb-rationale-list">
                    {selectedProgress.rationale.map((r, i) => (
                      <div key={i} className="rb-rationale-row">
                        <dt className="rb-rationale-term">{r.label}</dt>
                        <dd className="rb-rationale-detail">
                          {/^(?:problem|solution) code$/i.test(r.label)
                            ? <pre className="rb-context-evidence"><code>{r.detail}</code></pre>
                            : <ReviewShortText text={/diagram/i.test(r.label)
                              ? `\`\`\`text\n${r.detail}\n\`\`\`` : r.detail} diagrams />}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {!isArchitecture && selectedProgress.checks.length > 0 && (
                <div className="rb-checks">
                  <span className="rb-checks-label">
                    Meaningful checks
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
              </details>

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
                  No completed result was received. Use the review retry above.
                  {selectedProgress.error && <details><summary>Perspective failure details</summary>
                    <ErrorText error={selectedProgress.error} /></details>}
                </div>
              )}
              {selectedProgress.status === 'pending' && (
                <div className="rb-banner rb-banner-queued" role="status">
                  <strong>Queued for review.</strong> The AI reviewer runs
                  several perspectives in parallel across the warm metasessions
                  — this one is waiting for a free session. Existing findings
                  stay visible until it runs.
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
                  while it works — other perspectives review in parallel across
                  the warm metasessions.
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
                            : selectedProgress.status === 'done' && selectedAssessment === 'insufficient-evidence'
                              ? 'Insufficient evidence. No clean result can be certified.'
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
                    const savedGroup = board.uniqueFindings?.find((group) => group.finding.id === f.id || group.observations.some((finding) => finding.id === f.id));
                    const resolution = board.run
                      ? savedGroup?.disposition === 'dismissed' ? 'ignored' : savedGroup?.disposition === 'fix-verified' ? 'resolved' : null
                      : resolutionOf(resolutions, f.id);
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
                      <FindingDetail detail={f.detail} />
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
                        {state.publications[f.id] && <span>{state.publications[f.id] === 'posted' ? 'Posted · still requires review' : 'Publication uncertain — check the PR'}</span>}
                        {findingPath && (
                          <button
                            type="button"
                            className="rb-finding-act rb-finding-act-diff"
                            onClick={() => openFindingDiff(f)}
                            title="Open the referenced file diffs and comment inline"
                          >
                            <PrReviewIcon size={13} /> Open diff
                          </button>
                        )}
                        {resolution ? (!board.run &&
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
                              disabled={graphLoading || state.running || prep.active || state.publications[f.id] === 'posted'}
                              onClick={() => { setDetailsOpen(false); setPostTarget({
                                featureId, finding: f, board,
                                anchors: changeGraph?.status === 'ready' && graphHeadSha === board.pull.headSha
                                  ? findingCommentAnchors(f, changeGraph.nodes) : [],
                              }); }}
                              title="Leave an inline comment on the pull request for this finding"
                            >
                              <SendIcon size={14} /> Leave a comment
                            </button>
                            {!board.run && <button
                              type="button"
                              className="rb-finding-act"
                              onClick={() => {
                                setDetailsOpen(false);
                                setDispositionTarget(f.id);
                                setDispositionReason('');
                              }}
                              title="Dismiss this comment with a reason"
                            >
                              <CloseIcon size={13} /> Dismiss
                            </button>}
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

        <ExplainModel board={board} onOpenCodeReview={openEvidence} />
      </div>
      </Modal>}

      {dispositionTarget && <Modal title="Dismiss comment" onClose={() => setDispositionTarget(null)}>
        <label>Dismissal reason<textarea aria-label="Dismissal reason" value={dispositionReason}
          onChange={(event) => setDispositionReason(event.target.value)} /></label>
        <Button disabled={!dispositionReason.trim()} onClick={() => {
          reviewBoardRunStore.setFindingResolution(featureId, dispositionTarget, 'ignored', dispositionReason.trim());
          setDispositionTarget(null);
        }}>Dismiss with reason</Button>
      </Modal>}
      {postTarget && postTarget.featureId === featureId && (
        <FindingCommentDialog
          featureId={postTarget.featureId}
          finding={postTarget.finding}
          pullNumber={postTarget.board.pull.number}
          pullUrl={postTarget.board.pull.url}
          headSha={postTarget.board.pull.headSha ?? null}
          expectedRunId={postTarget.board.run?.id}
          expectedAssessmentRevision={postTarget.board.run?.revision}
          findingGroupId={postTarget.groupId ?? postTarget.board.uniqueFindings?.find((group) =>
            group.finding.id === postTarget.finding.id || group.observations.some((finding) => finding.id === postTarget.finding.id))?.id}
          publicationRecords={liveContext.publications}
          publicationHistoryUnavailable={liveContext.publicationsLoading || Boolean(liveContext.publicationsError)}
          onPublicationChange={(record) => {
            if (postingFindingIsCurrent()) {
              if (currentFeature.current === postTarget.featureId) liveContext.updatePublication(record);
              reviewBoardRunStore.setFindingPublication(postTarget.featureId, postTarget.finding.id, record.status);
            }
          }}
          initialPublicationUncertain={state.publications[postTarget.finding.id] === 'uncertain'}
          anchors={postTarget.anchors}
          isCurrent={postingFindingIsCurrent}
          onClose={() => setPostTarget(null)}
          onUncertain={() => {
            if (postingFindingIsCurrent()) reviewBoardRunStore.setFindingPublication(postTarget.featureId, postTarget.finding.id, 'uncertain');
          }}
          onPosted={() => {
            if (postingFindingIsCurrent()) {
              reviewBoardRunStore.setFindingPublication(postTarget.featureId, postTarget.finding.id, 'posted');
            }
            if (currentFeature.current === postTarget.featureId) comments.reload();
            if (currentFeature.current === postTarget.featureId) liveContext.refresh();
            setPostTarget((current) => current === postTarget ? null : current);
          }}
        />
      )}
      {diffTarget && (
        <Modal title={`Diff for ${diffTarget.title}`} size="full" className="rb-accessible-diff"
          onClose={() => setDiffTarget(null)}>
          <div
            className="rb-diff-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="rb-diff-modal-head">
              <div className="rb-diff-modal-titles">
                <span className="rb-diff-modal-label">
                  {visibleDiffFiles.length > 1
                    ? `${visibleDiffFiles.length} files · click a line to comment`
                    : 'Code diff · click a line to comment'}
                </span>
                <span className="rb-diff-modal-path">{diffTarget.title}</span>
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
              {diffTarget.allFiles && graphLoading && <p role="status">Loading changed files…</p>}
              {diffTarget.allFiles && graphError && <div role="alert">
                {graphError} <button type="button" onClick={() => setGraphAttempt((value) => value + 1)}><RefreshIcon size={13} /> Retry loading files</button>
              </div>}
              {diffTarget.allFiles && !graphLoading && !graphError && visibleDiffFiles.length !== board.changedFiles &&
                <p role="status">Showing {visibleDiffFiles.length} of {board.changedFiles} changed files captured in the change graph.</p>}
              {diffTarget.detail && (
                <div className="rb-diff-modal-detail">
                  <FindingDetail detail={diffTarget.detail} />
                </div>
              )}
              {visibleDiffFiles.length === 0 && !graphLoading && !graphError && (
                <p className="rb-checked-hint">
                  No file diff was captured for this reference. Run the analysis
                  (or take the latest) to build the change graph, then reopen.
                </p>
              )}
              {visibleDiffFiles.map((file, i) => (
                <details
                  key={file.path}
                  className="rb-diff-file"
                  open={i === 0}
                >
                  <summary className="rb-diff-file-summary">
                    <PrReviewIcon size={13} />
                    <span className="rb-diff-file-path">{file.path}</span>
                  </summary>
                  <div className="rb-diff-file-body">
                    {file.diff ? <CommentableDiff
                      comments={comments}
                      path={file.path}
                      diff={file.diff}
                      focusLine={diffTarget.focus?.path === file.path ? diffTarget.focus.line : null}
                    /> : <p className="rb-checked-hint">No text diff is available for this file (it may be binary or outside the captured diff limit).</p>}
                  </div>
                </details>
              ))}
            </div>
          </div>
        </Modal>
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
