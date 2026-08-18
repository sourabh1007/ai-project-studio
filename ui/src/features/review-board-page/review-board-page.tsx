import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { ApiError } from '../../lib/api.js';
import { Button, ErrorText } from '../../components/ui.js';
import { PrReviewIcon, RefreshIcon } from '../../components/icons.js';
import type {
  DetectedItem,
  ReviewBoard,
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

/** The "Explain Review Model" panel — why this board looks the way it does. */
function ExplainModel({ board }: { board: ReviewBoard }) {
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
              <span className="rb-evidence-source">{e.source}</span>
              <span className="rb-evidence-reason">{e.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PerspectiveCard({
  perspective,
  onSelect,
  selected,
}: {
  perspective: ReviewPerspective;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      className={`rb-card ${selected ? 'is-selected' : ''}`.trim()}
      onClick={onSelect}
    >
      <div className="rb-card-top">
        <span className="rb-card-name">{perspective.name}</span>
        {perspective.source === 'detected' && (
          <span className="rb-card-badge">Detected</span>
        )}
      </div>
      <p className="rb-card-why">{perspective.why}</p>
      <div className="rb-card-markers">
        <Marker kind="status" value={perspective.status} />
        <Marker kind="risk" value={perspective.risk} />
        {perspective.findings.length > 0 && (
          <span className="rb-card-findings">
            {perspective.findings.length} finding
            {perspective.findings.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
    </button>
  );
}

export function ReviewBoardPage({ featureId }: { featureId: string }) {
  const api = useApi();
  const [board, setBoard] = useState<ReviewBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useMemo(
    () => async () => {
      setLoading(true);
      setError(null);
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

  useEffect(() => {
    void load();
  }, [load]);

  const selected =
    board?.perspectives.find((p) => p.id === selectedId) ?? null;

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
          <Button variant="ghost" onClick={() => void load()}>
            <RefreshIcon size={14} /> Re-run
          </Button>
        </div>
      </header>

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
          {board.perspectives.map((p) => (
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
                <Marker kind="risk" value={p.risk} />
                {p.findings.length > 0 && (
                  <span className="rb-nav-count">{p.findings.length}</span>
                )}
              </span>
            </button>
          ))}
        </nav>

        <main className="rb-canvas">
          <ExplainModel board={board} />

          <section className="rb-board">
            <h3 className="rb-section-header">Dynamic review board</h3>
            <div className="rb-card-grid">
              {board.perspectives.map((p) => (
                <PerspectiveCard
                  key={p.id}
                  perspective={p}
                  selected={p.id === selectedId}
                  onSelect={() => setSelectedId(p.id)}
                />
              ))}
            </div>
          </section>

          {selected && (
            <section className="rb-detail">
              <h3 className="rb-section-header">{selected.name}</h3>
              <p className="rb-detail-why">{selected.why}</p>
              <div className="rb-detail-markers">
                <Marker kind="status" value={selected.status} />
                <Marker kind="risk" value={selected.risk} />
              </div>
              {selected.findings.length === 0 ? (
                <p className="rb-empty">
                  No deterministic findings for this perspective yet. Deeper,
                  AI-authored findings arrive in a later increment.
                </p>
              ) : (
                <ul className="rb-findings">
                  {selected.findings.map((f) => (
                    <li key={f.id} className={`rb-finding rb-sev-${f.severity}`}>
                      <div className="rb-finding-head">
                        <span className="rb-finding-title">{f.title}</span>
                        <Marker kind="status" value={f.status} />
                      </div>
                      <p className="rb-finding-detail">{f.detail}</p>
                      {f.evidence.length > 0 && (
                        <ul className="rb-evidence">
                          {f.evidence.map((e, i) => (
                            <li key={i}>
                              <span className="rb-evidence-source">
                                {e.source}
                              </span>
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

        <aside className="rb-agent" aria-label="Review agent">
          <h3 className="rb-card-header">Engineering Review Agent</h3>
          <p className="rb-agent-context">
            Context: #{board.pull.number}
            {selected ? ` · ${selected.name}` : ''}
          </p>
          <p className="rb-agent-placeholder">
            A context-aware review agent will let you challenge scores, ask why a
            risk was marked, and generate PR comments here. Coming in a later
            increment.
          </p>
        </aside>
      </div>
    </div>
  );
}
