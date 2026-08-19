import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { ApiError } from '../../lib/api.js';
import { Button, ErrorText } from '../../components/ui.js';
import {
  mapWithConcurrency,
  mergeAnalyzedPerspective,
} from '../../lib/review-board-progress.js';
import {
  AiChatIcon,
  AiMagicIcon,
  PrReviewIcon,
  RefreshIcon,
  SendIcon,
} from '../../components/icons.js';
import type {
  DetectedItem,
  ReviewBoard,
  ReviewBoardChatMessage,
  ReviewPerspective,
  ReviewRisk,
  ReviewStatus,
} from '../../lib/types.js';

/** How many perspectives the AI analyses at once — one at a time, in order. */
const ANALYZE_CONCURRENCY = 1;

/** Live per-perspective analysis state, keyed by perspective id. */
type PerspectiveStatus =
  | 'idle'
  | 'pending'
  | 'analyzing'
  | 'done'
  | 'skipped'
  | 'error';
interface PerspectiveProgress {
  status: PerspectiveStatus;
  skipReason: string | null;
  error: string | null;
}

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
  return (
    <div className="rb-explain">
      <h3 className="rb-card-header">Why this review model</h3>
      <div className="rb-explain-grid">
        <div>
          <span className="rb-meta-label">Detected project type</span>
          <span className="rb-meta-value">
            {model.projectType}{' '}
            <span className="rb-confidence">
              ({Math.round(model.projectTypeConfidence * 100)}% confidence)
            </span>
          </span>
        </div>
        <div>
          <span className="rb-meta-label">Languages</span>
          <span className="rb-meta-value">
            {[...model.primaryLanguages, ...model.secondaryLanguages].join(', ') ||
              'None detected'}
          </span>
        </div>
        <div>
          <span className="rb-meta-label">Deployment model</span>
          <span className="rb-meta-value">
            {model.deploymentModel || 'None detected'}
          </span>
        </div>
        <div>
          <span className="rb-meta-label">Blast-radius dimensions</span>
          <span className="rb-meta-value">
            {model.blastRadiusDimensions.join(', ')}
          </span>
        </div>
      </div>
      <DetectedList title="Configuration" items={model.configurationSystems} />
      <DetectedList title="Contracts" items={model.contracts} />
      <DetectedList title="Test signals" items={model.testSignals} />
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
  );
}

/** The context-aware review agent: a scoped chat over the selected perspective. */
function ReviewAgent({
  featureId,
  pullNumber,
  perspective,
}: {
  featureId: string;
  pullNumber: number;
  perspective: ReviewPerspective | null;
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
      <h3 className="rb-card-header">
        <AiChatIcon size={16} /> Engineering Review Agent
      </h3>
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
  const [board, setBoard] = useState<ReviewBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, PerspectiveProgress>>(
    {},
  );
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzed, setAnalyzed] = useState(false);
  // A monotonically increasing token that invalidates an in-flight analysis
  // run when the reviewer resets or re-analyses, plus the controller used to
  // abort its outstanding requests so a slow/hung perspective can't wedge the UI.
  const runToken = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useMemo(
    () => async () => {
      setLoading(true);
      setError(null);
      setProgress({});
      setAnalyzed(false);
      setAnalyzeError(null);
      try {
        const result = await api.getReviewBoard(featureId);
        setBoard(result);
        setSelectedId((prev) => prev ?? result.perspectives[0]?.id ?? null);
      } catch (err) {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Failed to load the review board.',
        );
      } finally {
        setLoading(false);
      }
    },
    [api, featureId],
  );

  const analyze = useMemo(
    () => async () => {
      if (!board) return;
      const ids = board.perspectives.map((p) => p.id);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const token = (runToken.current += 1);
      setAnalyzeError(null);
      setAnalyzed(true);
      setProgress(
        Object.fromEntries(
          ids.map((id) => [
            id,
            { status: 'pending', skipReason: null, error: null },
          ]),
        ),
      );
      await mapWithConcurrency(ids, ANALYZE_CONCURRENCY, async (id) => {
        if (token !== runToken.current) return;
        setProgress((prev) => ({
          ...prev,
          [id]: { status: 'analyzing', skipReason: null, error: null },
        }));
        try {
          const result = await api.analyzeReviewBoardPerspective(
            featureId,
            id,
            controller.signal,
          );
          if (token !== runToken.current) return;
          setBoard((prev) =>
            prev ? mergeAnalyzedPerspective(prev, result.perspective) : prev,
          );
          setProgress((prev) => ({
            ...prev,
            [id]: {
              status: result.skipped ? 'skipped' : 'done',
              skipReason: result.skipReason,
              error: null,
            },
          }));
        } catch (err) {
          if (token !== runToken.current) return;
          setProgress((prev) => ({
            ...prev,
            [id]: {
              status: 'error',
              skipReason: null,
              error:
                err instanceof ApiError
                  ? err.message
                  : 'This perspective could not be analysed.',
            },
          }));
        }
      });
    },
    [api, board, featureId],
  );

  // Reset abandons any in-flight run (invalidating late responses and aborting
  // outstanding requests) and reloads the deterministic board — always usable,
  // even mid-analysis, so a slow perspective can never trap the reviewer.
  const reset = useMemo(
    () => () => {
      runToken.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      void load();
    },
    [load],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const selected =
    board?.perspectives.find((p) => p.id === selectedId) ?? null;
  const selectedProgress: PerspectiveProgress =
    (selectedId && progress[selectedId]) || {
      status: 'idle',
      skipReason: null,
      error: null,
    };

  const progressValues = Object.values(progress);
  const analyzing = progressValues.some(
    (p) => p.status === 'analyzing' || p.status === 'pending',
  );
  const analyzedCount = progressValues.filter(
    (p) => p.status === 'done' || p.status === 'skipped' || p.status === 'error',
  ).length;
  const totalPerspectives = board?.perspectives.length ?? 0;

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
          <span className={`rb-reco rb-reco-${board.recommendation}`}>
            {RECOMMENDATION_LABEL[board.recommendation]}
          </span>
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

      {analyzeError && (
        <div className="rb-analyze-error">
          <ErrorText error={analyzeError} />
        </div>
      )}

      {analyzing && (
        <div className="rb-analyzing" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>
            Reviewing {analyzedCount} of {totalPerspectives} perspectives —
            findings appear as each one completes. Select any perspective to
            follow along.
          </span>
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

      <div className="rb-body">
        <nav className="rb-nav" aria-label="Review perspectives">
          {board.perspectives.map((p) => {
            const state = progress[p.id]?.status ?? 'idle';
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
                  {state === 'analyzing' && (
                    <span
                      className="spinner rb-nav-spin"
                      aria-label="Analyzing"
                      role="status"
                    />
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
          {selected && (
            <section className="rb-detail" ref={detailRef}>
              <div className="rb-detail-head">
                <h3 className="rb-section-header">{selected.name}</h3>
                {selected.source === 'detected' && (
                  <span className="rb-card-badge">Detected</span>
                )}
                {selectedProgress.status === 'analyzing' && (
                  <span className="rb-detail-working">
                    <span className="spinner" aria-hidden="true" /> AI reviewing…
                  </span>
                )}
                <span className="rb-detail-spacer" />
                <Marker kind="status" value={selected.status} />
                <Marker kind="risk" value={selected.risk} />
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
                  <button
                    type="button"
                    className="rb-linkish"
                    onClick={() => void analyze()}
                  >
                    Retry all
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
              {selectedProgress.status === 'analyzing' && (
                <div className="rb-banner rb-banner-working" role="status">
                  <span className="spinner" aria-hidden="true" /> The AI reviewer
                  is examining this perspective. Existing findings stay visible
                  while it works — remaining perspectives are queued and run one
                  by one.
                </div>
              )}

              {selected.findings.length === 0 ? (
                <div className="rb-detail-empty">
                  <p className="rb-empty">
                    {selectedProgress.status === 'analyzing'
                      ? 'Looking for evidence-backed findings for this perspective…'
                      : selectedProgress.status === 'pending'
                        ? 'Queued — the reviewer will analyse this perspective shortly.'
                        : selectedProgress.status === 'skipped'
                        ? 'No findings — the reviewer skipped this perspective for the reason above.'
                        : selectedProgress.status === 'done'
                          ? 'The AI reviewer raised no findings for this perspective — nothing here needs your attention.'
                          : 'No deterministic findings yet. Run the AI reviewer to author evidence-backed findings for this perspective.'}
                  </p>
                  {!analyzed && (
                    <Button
                      variant="primary"
                      onClick={() => void analyze()}
                      disabled={analyzing}
                    >
                      <AiMagicIcon size={14} /> Analyze with AI
                    </Button>
                  )}
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

          <ExplainModel board={board} onOpenCodeReview={onOpenCodeReview} />
        </main>

        <ReviewAgent
          featureId={featureId}
          pullNumber={board.pull.number}
          perspective={selected}
        />
      </div>
    </div>
  );
}
