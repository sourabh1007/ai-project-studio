import { useState, type CSSProperties } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { LiveState } from '../../lib/stream.js';
import { sessionLiveTotals } from '../../lib/stream.js';
import type { Feature, Session, SessionBreakdown } from '../../lib/types.js';
import { formatAic, formatCompactNumber } from '../../lib/format.js';
import { featureColor } from '../../lib/feature-color.js';
import { sessionDisplayName } from '../../lib/session-names.js';
import { Button, EmptyState, ErrorText } from '../../components/ui.js';
import {
  ChevronIcon,
  CheckIcon,
  CloseIcon,
  CollapseSidebarIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from '../../components/icons.js';
import { NewSessionForm } from './new-session-form.js';

/** Merges a persisted session with any live status/model updates. */
function mergeLive(session: Session, live: LiveState): Session {
  const liveSession = live.sessions[session.id];
  return liveSession ? { ...session, ...liveSession } : session;
}

function SessionRow({
  session,
  ordinal,
  customName,
  active,
  live,
  persisted,
  onOpen,
  onRename,
  onDelete,
}: {
  session: Session;
  ordinal: number;
  customName: string | undefined;
  active: boolean;
  live: LiveState;
  persisted: SessionBreakdown | undefined;
  onOpen: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);

  const dot =
    session.status === 'running'
      ? 'dot-running'
      : session.status === 'failed'
        ? 'dot-failed'
        : session.status === 'completed'
          ? 'dot-completed'
          : 'dot-idle';

  const name = sessionDisplayName(customName, ordinal);
  const model = session.resolvedModel ?? session.requestedModel;
  const liveTotals = sessionLiveTotals(live, session.id);
  // Prefer live SSE usage; fall back to persisted rollup so metrics
  // auto-populate after reloads (SSE does not replay history).
  const totals =
    liveTotals.turns > 0
      ? liveTotals
      : {
          nanoAiu: persisted?.nanoAiu ?? 0,
          inputTokens: persisted?.inputTokens ?? 0,
          outputTokens: persisted?.outputTokens ?? 0,
        };

  function startEditing() {
    setDraft(customName ?? name);
    setEditing(true);
  }

  function commit() {
    onRename(draft);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="session-item is-editing">
        <span className={`dot ${dot}`} aria-hidden="true" />
        <input
          className="session-name-input"
          autoFocus
          value={draft}
          aria-label="Session name"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commit();
            } else if (event.key === 'Escape') {
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className={`session-item ${active ? 'is-active' : ''}`.trim()}>
      <button
        type="button"
        className="session-open"
        aria-current={active ? 'true' : undefined}
        onClick={onOpen}
        onDoubleClick={startEditing}
      >
        <span className={`dot ${dot}`} aria-hidden="true" />
        <span className="session-body">
          <span className="session-name">{name}</span>
          <span className="session-meta" title={`${session.provider} · ${model}`}>
            {session.provider} · {model}
          </span>
        </span>
        <span className="session-metrics" aria-hidden="true">
          <span className="metric metric-credits" title="AIC used (github nano_aiu)">
            {formatAic(totals.nanoAiu)}
          </span>
          <span className="metric" title="Input tokens">
            ↑{formatCompactNumber(totals.inputTokens)}
          </span>
          <span className="metric" title="Output tokens">
            ↓{formatCompactNumber(totals.outputTokens)}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="session-rename"
        title="Rename session"
        aria-label={`Rename ${name}`}
        onClick={startEditing}
      >
        <PencilIcon />
      </button>
      {confirming ? (
        <span className="row-confirm" role="group" aria-label="Confirm delete">
          <button
            type="button"
            className="row-confirm-yes"
            title="Confirm delete"
            aria-label={`Confirm delete ${name}`}
            onClick={() => {
              setConfirming(false);
              onDelete();
            }}
          >
            <CheckIcon />
          </button>
          <button
            type="button"
            className="row-confirm-no"
            title="Cancel"
            aria-label="Cancel delete"
            onClick={() => setConfirming(false)}
          >
            <CloseIcon />
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="session-delete"
          title="Delete session"
          aria-label={`Delete ${name}`}
          onClick={() => setConfirming(true)}
        >
          <TrashIcon />
        </button>
      )}
    </div>
  );
}

function FeatureNode({
  feature,
  live,
  activeSessionId,
  names,
  onOpenSession,
  onOpenFeature,
  onRenameSession,
  onRenameFeature,
  onDeleteFeature,
  onDeleteSession,
}: {
  feature: Feature;
  live: LiveState;
  activeSessionId: string | null;
  names: Record<string, string>;
  onOpenSession: (session: Session, label: string) => void;
  onOpenFeature: (feature: Feature) => void;
  onRenameSession: (sessionId: string, name: string) => void;
  onRenameFeature: (feature: Feature, name: string) => Promise<void>;
  onDeleteFeature: (feature: Feature) => Promise<void>;
  onDeleteSession: (session: Session) => Promise<void>;
}) {
  const api = useApi();
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const sessions = useAsync(
    () => (expanded ? api.listSessions(feature.id) : Promise.resolve([])),
    [feature.id, expanded],
  );
  const usage = useAsync(
    () => (expanded ? api.getFeatureUsage(feature.id) : Promise.resolve(null)),
    [feature.id, expanded],
  );

  const rows = (sessions.data ?? []).map((s) => mergeLive(s, live));
  const persistedBySession = new Map(
    (usage.data?.bySession ?? []).map((s) => [s.sessionId, s]),
  );
  const accent = featureColor(feature.id);

  function startEditing() {
    setDraft(feature.name);
    setEditing(true);
  }

  async function commitName() {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== feature.name) {
      await onRenameFeature(feature, next);
    }
  }

  async function handleDeleteSession(session: Session) {
    await onDeleteSession(session);
    sessions.reload();
    usage.reload();
  }

  return (
    <div className="tree-node" style={{ '--feature-accent': accent } as CSSProperties}>
      <div className="tree-branch">
        <button
          type="button"
          className="tree-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${feature.name}` : `Expand ${feature.name}`}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="chevron" aria-hidden="true">
            <ChevronIcon open={expanded} />
          </span>
        </button>
        <span className="feature-swatch" aria-hidden="true" />
        {editing ? (
          <input
            className="feature-name-input"
            autoFocus
            value={draft}
            aria-label="Feature name"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitName();
              } else if (event.key === 'Escape') {
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="tree-branch-label"
            title={`Open ${feature.name} analytics`}
            onClick={() => onOpenFeature(feature)}
            onDoubleClick={startEditing}
          >
            {feature.name}
          </button>
        )}
        <button
          type="button"
          className="tree-action"
          title="Rename feature"
          aria-label={`Rename ${feature.name}`}
          onClick={startEditing}
        >
          <PencilIcon />
        </button>
        <button
          type="button"
          className="tree-action"
          title="New session"
          aria-label={`New session in ${feature.name}`}
          onClick={() => {
            setExpanded(true);
            setCreating(true);
          }}
        >
          <PlusIcon />
        </button>
        {confirming ? (
          <span className="row-confirm" role="group" aria-label="Confirm delete">
            <button
              type="button"
              className="row-confirm-yes"
              title="Confirm delete"
              aria-label={`Confirm delete ${feature.name}`}
              onClick={() => {
                setConfirming(false);
                void onDeleteFeature(feature);
              }}
            >
              <CheckIcon />
            </button>
            <button
              type="button"
              className="row-confirm-no"
              title="Cancel"
              aria-label="Cancel delete"
              onClick={() => setConfirming(false)}
            >
              <CloseIcon />
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="tree-action tree-action-danger"
            title="Delete feature"
            aria-label={`Delete ${feature.name}`}
            onClick={() => setConfirming(true)}
          >
            <TrashIcon />
          </button>
        )}
      </div>

      {expanded && (
        <div className="tree-children">
          {creating && (
            <NewSessionForm
              featureId={feature.id}
              onCreated={(session) => {
                setCreating(false);
                sessions.reload();
                usage.reload();
                onOpenSession(
                  session,
                  sessionDisplayName(names[session.id], rows.length + 1),
                );
              }}
              onCancel={() => setCreating(false)}
            />
          )}
          {sessions.loading && <EmptyState message="Loading sessions…" />}
          <ErrorText error={sessions.error} />
          {!sessions.loading && rows.length === 0 && !creating && (
            <EmptyState message="No sessions yet." />
          )}
          {rows.map((session, index) => (
            <SessionRow
              key={session.id}
              session={session}
              ordinal={index + 1}
              customName={names[session.id]}
              active={session.id === activeSessionId}
              live={live}
              persisted={persistedBySession.get(session.id)}
              onOpen={() =>
                onOpenSession(
                  session,
                  sessionDisplayName(names[session.id], index + 1),
                )
              }
              onRename={(name) => onRenameSession(session.id, name)}
              onDelete={() => handleDeleteSession(session)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * IDE-style Explorer: Features are the "projects" and Sessions are their
 * "files". Create Features inline and launch Sessions per Feature; selecting a
 * session opens its live terminal in the editor pane.
 */
export function Explorer({
  live,
  activeSessionId,
  names,
  onOpenSession,
  onOpenFeature,
  onRenameSession,
  onRenameFeature,
  onDeleteFeature,
  onDeleteSession,
  onCollapse,
}: {
  live: LiveState;
  activeSessionId: string | null;
  names: Record<string, string>;
  onOpenSession: (session: Session, label: string) => void;
  onOpenFeature: (feature: Feature) => void;
  onRenameSession: (sessionId: string, name: string) => void;
  onRenameFeature: (feature: Feature, name: string) => Promise<void>;
  onDeleteFeature: (feature: Feature) => Promise<void>;
  onDeleteSession: (session: Session) => Promise<void>;
  onCollapse: () => void;
}) {
  const api = useApi();
  const features = useAsync(() => api.listFeatures(), []);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function createFeature() {
    if (!name.trim()) {
      setFormError('Name is required');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await api.createFeature({ name: name.trim(), description });
      setName('');
      setDescription('');
      setAdding(false);
      features.reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function renameFeature(feature: Feature, next: string) {
    await onRenameFeature(feature, next);
    features.reload();
  }

  async function deleteFeature(feature: Feature) {
    await onDeleteFeature(feature);
    features.reload();
  }

  return (
    <div className="explorer">
      <div className="explorer-header">
        <span className="explorer-title">Explorer</span>
        <div className="explorer-header-actions">
          <button
            type="button"
            className="tree-action"
            title="New feature"
            aria-label="New feature"
            onClick={() => setAdding((v) => !v)}
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            className="tree-action"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
            onClick={onCollapse}
          >
            <CollapseSidebarIcon />
          </button>
        </div>
      </div>

      {adding && (
        <div className="new-feature glass">
          <div className="field">
            <label htmlFor="new-feature-name">Name</label>
            <input
              id="new-feature-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Checkout redesign"
            />
          </div>
          <div className="field">
            <label htmlFor="new-feature-desc">Description</label>
            <textarea
              id="new-feature-desc"
              className="textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What are you building?"
            />
          </div>
          <ErrorText error={formError} />
          <div className="row">
            <Button onClick={createFeature} disabled={submitting}>
              {submitting ? 'Creating…' : 'Create'}
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="explorer-body">
        {features.loading && <EmptyState message="Loading features…" />}
        <ErrorText error={features.error} />
        {features.data && features.data.length === 0 && !adding && (
          <EmptyState message="No features yet. Create your first one." />
        )}
        {features.data?.map((feature) => (
          <FeatureNode
            key={feature.id}
            feature={feature}
            live={live}
            activeSessionId={activeSessionId}
            names={names}
            onOpenSession={onOpenSession}
            onOpenFeature={onOpenFeature}
            onRenameSession={onRenameSession}
            onRenameFeature={renameFeature}
            onDeleteFeature={deleteFeature}
            onDeleteSession={onDeleteSession}
          />
        ))}
      </div>
    </div>
  );
}
