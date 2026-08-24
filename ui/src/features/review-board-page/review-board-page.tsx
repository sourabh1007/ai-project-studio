import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useApi } from '../../app/api-context.js';
import { ApiError } from '../../lib/api.js';
import { Button, ErrorText } from '../../components/ui.js';
import { useUsageStream } from '../../hooks/use-usage-stream.js';
import { reviewBoardActivityLines } from '../../lib/stream.js';
import {
  reviewBoardRunStore,
  type PerspectiveProgress,
} from './review-board-run-store.js';
import {
  allPerspectivesReviewed,
  isPerspectiveReviewed,
  perspectiveBadgeLabel,
  reviewedCount,
} from '../../lib/review-signoff.js';
import {
  AiChatIcon,
  AiMagicIcon,
  CloseIcon,
  ExpandIcon,
  PrReviewIcon,
  RefreshIcon,
  RestoreIcon,
  SendIcon,
} from '../../components/icons.js';
import type {
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

/**
 * An evidence source label. When the board can open the underlying Code Review
 * (where the change graph, diffs and changed files live), it renders as a real
 * link that jumps there; otherwise it's a plain label.
 */
function EvidenceSource({
  source,
  onOpenCodeReview,
}: {
  source: string;
  onOpenCodeReview?: () => void;
}) {
  if (!onOpenCodeReview) {
    return <span className="rb-evidence-source">{source}</span>;
  }
  return (
    <button
      type="button"
      className="rb-evidence-source rb-evidence-link"
      onClick={onOpenCodeReview}
      title="Open in Code Review"
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
  onOpenCodeReview?: () => void;
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
}: {
  featureId: string;
  pullNumber: number;
  perspective: ReviewPerspective | null;
  focused: boolean;
  onToggleFocus: () => void;
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
  onOpenCodeReview?: () => void;
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
    }),
    [api],
  );
  const state = useSyncExternalStore(
    (listener) => reviewBoardRunStore.subscribe(featureId, listener),
    () => reviewBoardRunStore.getState(featureId),
  );
  const { board, loading, loadError: error, analyzed, progress, signoff } =
    state;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which of the three panels is expanded to fill the body, or null for the
  // default three-column layout.
  const [focus, setFocus] = useState<'nav' | 'canvas' | 'agent' | null>(null);
  // Lets the reviewer dismiss the "reviewing…" progress banner for the run.
  const [bannerHidden, setBannerHidden] = useState(false);
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
    () => () => {
      setBannerHidden(false);
      return reviewBoardRunStore.analyze(featureId, runApi);
    },
    [featureId, runApi],
  );
  const analyzeOne = useMemo(
    () => (perspectiveId: string) => {
      setBannerHidden(false);
      return reviewBoardRunStore.analyzeOne(featureId, perspectiveId, runApi);
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

  // Load the clean board on mount; the store no-ops if a run is already live.
  useEffect(() => {
    void reviewBoardRunStore.load(featureId, runApi);
  }, [featureId, runApi]);

  const selected =
    board?.perspectives.find((p) => p.id === selectedId) ?? null;
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
  const analyzing = progressValues.some(
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
          </p>
        </div>
        <div className="rb-header-side">
          <span
            className={`rb-reco rb-reco-${
              prReviewed ? 'approve' : board.recommendation
            }`}
          >
            {analyzing
              ? 'Reviewing'
              : prReviewed
                ? 'PR reviewed'
                : RECOMMENDATION_LABEL[board.recommendation]}
          </span>
          <span className="rb-review-progress" title="Perspectives you have reviewed">
            {reviewedN}/{totalPerspectives} reviewed
          </span>
          {prReviewed ? (
            <Button variant="ghost" onClick={() => clearPrReviewed()}>
              <RestoreIcon size={14} /> Re-open PR
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => markPrReviewed(perspectiveIds)}
              disabled={!allReviewed}
            >
              Mark PR reviewed
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => void analyze()}
            disabled={analyzing}
          >
            {analyzing ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <AiMagicIcon size={14} />
            )}{' '}
            {analyzing
              ? 'Analyzing…'
              : analyzed
                ? 'Re-analyze with AI'
                : 'Analyze with AI'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => reset()}
          >
            <RefreshIcon size={14} /> {analyzing ? 'Stop & reset' : 'Reset'}
          </Button>
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
                    <span className="rb-nav-queued" title="Queued for review">
                      Queued
                    </span>
                  )}
                  {(state === 'analyzing' || state === 'retrying') && (
                    <span
                      className="spinner rb-nav-spin"
                      aria-label={state === 'retrying' ? 'Retrying' : 'Analyzing'}
                      role="status"
                    />
                  )}
                  {state === 'retrying' && (
                    <span
                      className="rb-nav-queued"
                      title="Retrying after a transient failure"
                    >
                      Retry {progress[p.id]?.attempt ?? 2}/{3}
                    </span>
                  )}
                  {state === 'skipped' && (
                    <span className="rb-nav-skip">Skipped</span>
                  )}
                  {state === 'error' && (
                    <span className="rb-nav-err" title="Analysis failed">
                      !
                    </span>
                  )}
                  {state === 'done' && p.findings.length === 0 && (
                    <span className="rb-nav-clean" title="Analyzed — no findings">
                      ✓
                    </span>
                  )}
                  <span
                    className={`rb-nav-verdict rb-verdict-${
                      navAnalyzing ? 'reviewing' : p.status
                    }`}
                  >
                    {perspectiveBadgeLabel(navAnalyzing, p.status)}
                  </span>
                  {navReviewed && (
                    <span
                      className="rb-nav-reviewed"
                      title="You marked this perspective reviewed"
                    >
                      ✓ You
                    </span>
                  )}
                  <Marker kind="risk" value={p.risk} />
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
                <Button
                  variant="ghost"
                  onClick={() => void analyzeOne(selected.id)}
                  disabled={
                    selectedProgress.status === 'analyzing' ||
                    selectedProgress.status === 'retrying' ||
                    selectedProgress.status === 'pending'
                  }
                >
                  <AiMagicIcon size={13} />{' '}
                  {selectedProgress.status === 'done' ||
                  selectedProgress.status === 'skipped'
                    ? 'Re-analyze this'
                    : 'Analyze this'}
                </Button>
                <Button
                  variant={selectedReviewed ? 'ghost' : 'primary'}
                  onClick={() =>
                    setPerspectiveReviewed(selected.id, !selectedReviewed)
                  }
                  disabled={selectedAnalyzing}
                >
                  {selectedReviewed ? '✓ Reviewed by you' : 'Mark reviewed'}
                </Button>
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

              {selectedProgress.checked && (
                <div className="rb-checked" role="note">
                  <span className="rb-checked-label">
                    What was checked for this rating
                  </span>
                  <p className="rb-checked-text">{selectedProgress.checked}</p>
                  <p className="rb-checked-hint">
                    Disagree with this rating? Challenge it with the review agent
                    on the right — point at the code and it will re-evaluate. →
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
                        <dd className="rb-rationale-detail">{r.detail}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {selectedProgress.checks.length > 0 && (
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
                  {selected.findings.map((f) => (
                    <li key={f.id} className={`rb-finding rb-sev-${f.severity}`}>
                      <div className="rb-finding-head">
                        <span className="rb-finding-title">{f.title}</span>
                        <span className={`rb-sev-tag rb-sev-tag-${f.severity}`}>
                          {f.severity}
                        </span>
                        <Marker kind="status" value={f.status} />
                      </div>
                      <p className="rb-finding-detail">{f.detail}</p>
                      {f.evidence.length > 0 && (
                        <ul className="rb-evidence">
                          {f.evidence.map((e, i) => (
                            <li key={i}>
                              <EvidenceSource
                                source={e.source}
                                onOpenCodeReview={onOpenCodeReview}
                              />
                              <span className="rb-evidence-reason">
                                {e.reason}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </main>

        <ReviewAgent
          featureId={featureId}
          pullNumber={board.pull.number}
          perspective={selected}
          focused={focus === 'agent'}
          onToggleFocus={() => setFocus(focus === 'agent' ? null : 'agent')}
          onRatingChange={(change) =>
            reviewBoardRunStore.applyRatingChange(featureId, change)
          }
        />

        <ExplainModel board={board} onOpenCodeReview={onOpenCodeReview} />
      </div>
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
