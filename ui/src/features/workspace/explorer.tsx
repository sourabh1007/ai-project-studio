import { useState, type CSSProperties } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { LiveState } from '../../lib/stream.js';
import { liveSignal, resolveSessionMetrics, sessionLiveTotals } from '../../lib/stream.js';
import type { Feature, Repository, Session, SessionBreakdown } from '../../lib/types.js';
import { formatAic, formatCompactNumber, formatDuration } from '../../lib/format.js';
import { featureColor } from '../../lib/feature-color.js';
import { sessionDisplayName } from '../../lib/session-names.js';
import { sessionDotClass } from '../../lib/session-status.js';
import { Button, EmptyState, ErrorText, Modal } from '../../components/ui.js';
import {
  ChevronIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CloseIcon,
  CollapseSidebarIcon,
  FilesIcon,
  ImportIcon,
  PencilIcon,
  PlusIcon,
  RepoIcon,
  TagIcon,
  TimeIcon,
  TrashIcon,
  UsageIcon,
} from '../../components/icons.js';
import { OverflowMenu } from '../../components/overflow-menu.js';
import { SkillChips } from '../skills/skill-chips.js';
import { SkillTagger } from '../skills/skill-tagger.js';
import { SessionFiles } from './session-files.js';
import { NewSessionForm } from './new-session-form.js';
import { ImportSessionPanel } from './import-session-panel.js';
import { RepoPicker } from './repo-picker.js';
import { GithubStatusBadge } from '../github/github-status.js';
import { AzureStatusBadge } from '../azure/azure-status.js';

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
  onRename: (name: string) => void | Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [managingSkills, setManagingSkills] = useState(false);
  const [skillSignal, setSkillSignal] = useState(0);

  const dot = sessionDotClass(session.status);

  // The persisted name is authoritative; fall back to any legacy localStorage
  // name (pre-persistence installs) and finally the ordinal label.
  const name = sessionDisplayName(session.name ?? customName, ordinal);
  const model = session.resolvedModel ?? session.requestedModel;
  const liveTotals = sessionLiveTotals(live, session.id);
  // The persisted rollup is the authoritative source of truth: every usage
  // event is persisted and emitted together on the backend, so the rollup is
  // complete across reloads, whereas the live SSE feed only carries events
  // observed since the UI connected. We therefore prefer persisted totals —
  // the same basis the status bar uses — so the per-session AIC always matches
  // the workspace footer. Live totals are only a fallback for brand-new
  // sessions whose first events have not yet been folded into the rollup.
  const totals = resolveSessionMetrics(persisted, liveTotals);

  function startEditing() {
    setDraft(session.name ?? customName ?? '');
    setEditing(true);
  }

  function commit() {
    onRename(draft);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="session-card is-editing">
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
    <div className={`session-card ${active ? 'is-active' : ''}`.trim()}>
      <div className="session-card-head">
        <button
          type="button"
          className="session-open"
          aria-current={active ? 'true' : undefined}
          onClick={onOpen}
          onDoubleClick={startEditing}
        >
          <span className={`dot ${dot}`} aria-hidden="true" />
          <span className="session-name">{name}</span>
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
          <OverflowMenu
            label={`Actions for ${name}`}
            actions={[
              {
                label: 'Rename',
                icon: <PencilIcon />,
                onSelect: startEditing,
              },
              {
                label: 'Manage skills',
                icon: <TagIcon />,
                onSelect: () => setManagingSkills(true),
              },
              {
                label: 'Delete',
                icon: <TrashIcon />,
                danger: true,
                onSelect: () => setConfirming(true),
              },
            ]}
          />
        )}
      </div>

      {managingSkills && (
        <Modal title={`Skills · ${name}`} onClose={() => setManagingSkills(false)}>
          <SkillTagger
            scope="session"
            targetId={session.id}
            onChange={() => setSkillSignal((v) => v + 1)}
          />
        </Modal>
      )}

      <div className="session-meta-row" title={`${session.provider} · ${model}`}>
        {session.provider} · {model}
      </div>

      <SkillChips scope="session" targetId={session.id} reloadSignal={skillSignal} />

      <div className="session-metrics-row" aria-hidden="true">
        <span className="metric metric-credits" title="AIC used (github nano_aiu)">
          <UsageIcon size={11} /> {formatAic(totals.nanoAiu)}
        </span>
        <span className="metric" title="Input tokens">
          <ArrowUpIcon size={11} /> {formatCompactNumber(totals.inputTokens)}
        </span>
        <span className="metric" title="Output tokens">
          <ArrowDownIcon size={11} /> {formatCompactNumber(totals.outputTokens)}
        </span>
        <span className="metric" title="Active time on this session">
          <TimeIcon size={11} /> {formatDuration(persisted?.activeMs ?? 0)}
        </span>
      </div>

      <div className="session-files">
        <button
          type="button"
          className="session-files-toggle"
          aria-expanded={filesOpen}
          onClick={() => setFilesOpen((v) => !v)}
        >
          <span className="chevron" aria-hidden="true">
            <ChevronIcon open={filesOpen} size={12} />
          </span>
          <FilesIcon size={12} />
          <span>Files</span>
        </button>
        {filesOpen && <SessionFiles sessionId={session.id} />}
      </div>
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
  onRenameSession: (sessionId: string, name: string) => void | Promise<void>;
  onRenameFeature: (feature: Feature, name: string) => Promise<void>;
  onDeleteFeature: (feature: Feature) => Promise<void>;
  onDeleteSession: (session: Session) => Promise<void>;
}) {
  const api = useApi();
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const sessions = useAsync(
    () => (expanded ? api.listSessions(feature.id) : Promise.resolve([])),
    [feature.id, expanded],
  );
  const usage = useAsync(
    () => (expanded ? api.getFeatureUsage(feature.id) : Promise.resolve(null)),
    // Re-fetch the authoritative rollup whenever a new usage/session event is
    // observed so per-session metrics stay in lockstep with the status bar,
    // which refreshes on the same signal.
    [feature.id, expanded, liveSignal(live)],
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
    setActionError(null);
    try {
      await onDeleteSession(session);
      sessions.reload();
      usage.reload();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Failed to delete session.',
      );
    }
  }

  async function handleRenameSession(sessionId: string, name: string) {
    setActionError(null);
    try {
      await onRenameSession(sessionId, name);
      // Reload so the persisted name from the backend becomes authoritative.
      sessions.reload();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Failed to rename session.',
      );
    }
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
          title="New session"
          aria-label={`New session in ${feature.name}`}
          onClick={() => {
            setExpanded(true);
            setImporting(false);
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
          <OverflowMenu
            label={`Actions for ${feature.name}`}
            actions={[
              {
                label: 'Rename',
                icon: <PencilIcon />,
                onSelect: startEditing,
              },
              {
                label: 'Import session',
                icon: <ImportIcon />,
                onSelect: () => {
                  setExpanded(true);
                  setCreating(false);
                  setImporting(true);
                },
              },
              {
                label: 'Delete feature',
                icon: <TrashIcon />,
                danger: true,
                onSelect: () => setConfirming(true),
              },
            ]}
          />
        )}
      </div>

      <div className="feature-tags">
        <SkillChips scope="feature" targetId={feature.id} />
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
          {importing && (
            <ImportSessionPanel
              featureId={feature.id}
              onImported={() => {
                setImporting(false);
                sessions.reload();
                usage.reload();
              }}
              onCancel={() => setImporting(false)}
            />
          )}
          {sessions.loading && <EmptyState message="Loading sessions…" />}
          <ErrorText error={sessions.error} />
          {!sessions.loading && rows.length === 0 && !creating && !importing && (
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
              onRename={(name) => handleRenameSession(session.id, name)}
              onDelete={() => handleDeleteSession(session)}
            />
          ))}
          <ErrorText error={actionError} />
        </div>
      )}
    </div>
  );
}

/** A collapsible top-level repository (or the "No repository" group when
 * `repo` is null) that holds the features scoped to it. */
function RepoNode({
  repo,
  features,
  defaultExpanded,
  live,
  activeSessionId,
  names,
  onOpenSession,
  onOpenFeature,
  onRenameSession,
  onRenameFeature,
  onDeleteFeature,
  onDeleteSession,
  onAddFeature,
  onDeleteRepo,
}: {
  repo: Repository | null;
  features: Feature[];
  defaultExpanded: boolean;
  live: LiveState;
  activeSessionId: string | null;
  names: Record<string, string>;
  onOpenSession: (session: Session, label: string) => void;
  onOpenFeature: (feature: Feature) => void;
  onRenameSession: (sessionId: string, name: string) => void | Promise<void>;
  onRenameFeature: (feature: Feature, name: string) => Promise<void>;
  onDeleteFeature: (feature: Feature) => Promise<void>;
  onDeleteSession: (session: Session) => Promise<void>;
  onAddFeature: (repoId: string | null) => void;
  onDeleteRepo: (repo: Repository) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [confirming, setConfirming] = useState(false);
  const title = repo ? repo.name : 'No repository';
  const providerLabel = repo?.provider === 'azure-devops' ? 'Azure DevOps' : 'GitHub';

  return (
    <div className={`repo-node ${repo ? '' : 'repo-node-orphan'}`.trim()}>
      <div className="tree-branch repo-branch">
        <button
          type="button"
          className="tree-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="chevron" aria-hidden="true">
            <ChevronIcon open={expanded} />
          </span>
        </button>
        <span className="repo-icon" aria-hidden="true">
          <RepoIcon size={14} />
        </span>
        <span
          className="repo-branch-label"
          title={repo ? `${providerLabel} · ${repo.localPath}` : 'Features without a repository'}
        >
          {title}
        </span>
        {repo && <span className="repo-provider-chip">{providerLabel}</span>}
        <button
          type="button"
          className="tree-action"
          title="New feature"
          aria-label={`New feature in ${title}`}
          onClick={() => {
            setExpanded(true);
            onAddFeature(repo?.id ?? null);
          }}
        >
          <PlusIcon />
        </button>
        {repo &&
          (confirming ? (
            <span className="row-confirm" role="group" aria-label="Confirm delete">
              <button
                type="button"
                className="row-confirm-yes"
                title="Confirm remove"
                aria-label={`Confirm remove ${title}`}
                onClick={() => {
                  setConfirming(false);
                  onDeleteRepo(repo);
                }}
              >
                <CheckIcon />
              </button>
              <button
                type="button"
                className="row-confirm-no"
                title="Cancel"
                aria-label="Cancel remove"
                onClick={() => setConfirming(false)}
              >
                <CloseIcon />
              </button>
            </span>
          ) : (
            <OverflowMenu
              label={`Actions for ${title}`}
              actions={[
                {
                  label: 'Remove repository',
                  icon: <TrashIcon />,
                  danger: true,
                  onSelect: () => setConfirming(true),
                },
              ]}
            />
          ))}
      </div>

      {expanded && (
        <div className="tree-children repo-children">
          {features.length === 0 && (
            <EmptyState message="No features yet." />
          )}
          {features.map((feature) => (
            <FeatureNode
              key={feature.id}
              feature={feature}
              live={live}
              activeSessionId={activeSessionId}
              names={names}
              onOpenSession={onOpenSession}
              onOpenFeature={onOpenFeature}
              onRenameSession={onRenameSession}
              onRenameFeature={onRenameFeature}
              onDeleteFeature={onDeleteFeature}
              onDeleteSession={onDeleteSession}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * IDE-style Explorer with a Repository → Feature → Session hierarchy.
 * Repositories are the top-level "projects"; features group the work done on a
 * repo and sessions run inside its local checkout. Add a repo from the header,
 * create features under it, and launch sessions per feature.
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
  onRenameSession: (sessionId: string, name: string) => void | Promise<void>;
  onRenameFeature: (feature: Feature, name: string) => Promise<void>;
  onDeleteFeature: (feature: Feature) => Promise<void>;
  onDeleteSession: (session: Session) => Promise<void>;
  onCollapse: () => void;
}) {
  const api = useApi();
  const repos = useAsync(() => api.listRepos(), []);
  const features = useAsync(() => api.listFeatures(), []);
  const [addingRepo, setAddingRepo] = useState(false);
  const [adding, setAdding] = useState(false);
  const [targetRepoId, setTargetRepoId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function openFeatureForm(repoId: string | null) {
    setTargetRepoId(repoId);
    setName('');
    setDescription('');
    setFormError(null);
    setAdding(true);
  }

  async function createFeature() {
    if (!name.trim()) {
      setFormError('Name is required');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await api.createFeature({
        name: name.trim(),
        description,
        repoId: targetRepoId,
      });
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

  function closeForm() {
    setAdding(false);
    setName('');
    setDescription('');
    setFormError(null);
  }

  async function renameFeature(feature: Feature, next: string) {
    await onRenameFeature(feature, next);
    features.reload();
  }

  async function deleteFeature(feature: Feature) {
    await onDeleteFeature(feature);
    features.reload();
  }

  async function deleteRepo(repo: Repository) {
    await api.deleteRepo(repo.id);
    repos.reload();
    features.reload();
  }

  const allFeatures = features.data ?? [];
  const repoList = repos.data ?? [];
  const orphanFeatures = allFeatures.filter(
    (f) => !f.repoId || !repoList.some((r) => r.id === f.repoId),
  );

  return (
    <div className="explorer">
      <div className="explorer-header">
        <span className="explorer-title">Explorer</span>
        <div className="explorer-header-actions">
          <button
            type="button"
            className="tree-action"
            title="Add repository"
            aria-label="Add repository"
            onClick={() => setAddingRepo(true)}
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

      {addingRepo && (
        <RepoPicker
          onClose={() => setAddingRepo(false)}
          onAdded={() => {
            setAddingRepo(false);
            repos.reload();
          }}
        />
      )}

      {adding && (
        <Modal title="New feature" onClose={closeForm}>
          <div className="feature-form">
            <div className="field">
              <label htmlFor="new-feature-name">Name</label>
              <input
                id="new-feature-name"
                className="input"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Checkout redesign"
              />
            </div>
            <div className="field">
              <label htmlFor="new-feature-desc">Description</label>
              <textarea
                id="new-feature-desc"
                className="textarea textarea-lg"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What are you building?"
              />
            </div>
            <ErrorText error={formError} />
            <div className="row modal-actions">
              <Button variant="ghost" onClick={closeForm}>
                Cancel
              </Button>
              <Button onClick={createFeature} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create feature'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      <div className="explorer-body">
        {(repos.loading || features.loading) && (
          <EmptyState message="Loading workspace…" />
        )}
        <ErrorText error={repos.error} />
        <ErrorText error={features.error} />
        {!repos.loading &&
          !features.loading &&
          repoList.length === 0 &&
          orphanFeatures.length === 0 && (
            <EmptyState message="No repositories yet. Add one to get started." />
          )}
        {repoList.map((repo) => (
          <RepoNode
            key={repo.id}
            repo={repo}
            features={allFeatures.filter((f) => f.repoId === repo.id)}
            defaultExpanded
            live={live}
            activeSessionId={activeSessionId}
            names={names}
            onOpenSession={onOpenSession}
            onOpenFeature={onOpenFeature}
            onRenameSession={onRenameSession}
            onRenameFeature={renameFeature}
            onDeleteFeature={deleteFeature}
            onDeleteSession={onDeleteSession}
            onAddFeature={openFeatureForm}
            onDeleteRepo={deleteRepo}
          />
        ))}
        {orphanFeatures.length > 0 && (
          <RepoNode
            repo={null}
            features={orphanFeatures}
            defaultExpanded={repoList.length === 0}
            live={live}
            activeSessionId={activeSessionId}
            names={names}
            onOpenSession={onOpenSession}
            onOpenFeature={onOpenFeature}
            onRenameSession={onRenameSession}
            onRenameFeature={renameFeature}
            onDeleteFeature={deleteFeature}
            onDeleteSession={onDeleteSession}
            onAddFeature={openFeatureForm}
            onDeleteRepo={deleteRepo}
          />
        )}
      </div>

      <div className="explorer-footer">
        <GithubStatusBadge />
        <AzureStatusBadge />
      </div>
    </div>
  );
}
