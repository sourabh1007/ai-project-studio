import {
  Fragment,
  useEffect,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { LiveState } from '../../lib/stream.js';
import { liveSignal, resolveSessionMetrics, sessionLiveTotals } from '../../lib/stream.js';
import type {
  Feature,
  MoveNodeInput,
  Repository,
  RepositoryContext,
  Session,
  SessionBreakdown,
  TreeGroup,
} from '../../lib/types.js';
import { formatAic, formatCompactNumber, formatDuration } from '../../lib/format.js';
import { featureColor } from '../../lib/feature-color.js';
import { sessionDisplayName } from '../../lib/session-names.js';
import { sessionDotClass } from '../../lib/session-status.js';
import { Button, ConfirmDialog, EmptyState, ErrorText, Modal } from '../../components/ui.js';
import { SkeletonList } from '../../components/loading.js';
import {
  ChevronIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CloseIcon,
  CollapseSidebarIcon,
  FilesIcon,
  FolderIcon,
  ImportIcon,
  PencilIcon,
  PlusIcon,
  PrReviewIcon,
  PullRequestIcon,
  RepoIcon,
  SkillsIcon,
  TagIcon,
  TimeIcon,
  TrashIcon,
  UsageIcon,
  WarningIcon,
} from '../../components/icons.js';
import { OverflowMenu } from '../../components/overflow-menu.js';
import { UsageBreakdownModal } from '../../components/usage-breakdown.js';
import { SkillChips } from '../skills/skill-chips.js';
import { SkillTagger } from '../skills/skill-tagger.js';
import { SessionFiles } from './session-files.js';
import { beginDragFx, endDragFx } from './drag-fx.js';
import { NewSessionForm } from './new-session-form.js';
import { ImportSessionPanel } from './import-session-panel.js';
import {
  APPEND_INDEX,
  FeatureTree,
  NodeDragStoreProvider,
  useNodeDragStore,
} from './feature-tree.js';
import { GroupPrPicker, type PickedPull } from './group-pr-picker.js';
import { RepoPicker } from './repo-picker.js';
import { PrReviewPicker } from './pr-review-picker.js';
import { GithubStatusBadge } from '../github/github-status.js';
import { AzureStatusBadge } from '../azure/azure-status.js';
import {
  RepositoryContextBadge,
  RepositoryContextViewer,
} from './repository-context.js';

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
  const [viewingUsage, setViewingUsage] = useState(false);
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

      <div className="session-metrics-row">
        <button
          type="button"
          className="session-metrics-open"
          title="View how this session's credits and tokens were used"
          aria-label={`Usage breakdown for ${name}`}
          onClick={() => setViewingUsage(true)}
        >
          <span className="metric metric-credits">
            <UsageIcon size={11} /> {formatAic(totals.nanoAiu)}
          </span>
          <span className="metric">
            <ArrowUpIcon size={11} /> {formatCompactNumber(totals.inputTokens)}
          </span>
          <span className="metric">
            <ArrowDownIcon size={11} /> {formatCompactNumber(totals.outputTokens)}
          </span>
          <span className="metric">
            <TimeIcon size={11} /> {formatDuration(persisted?.activeMs ?? 0)}
          </span>
        </button>
      </div>

      {viewingUsage && (
        <UsageBreakdownModal
          scope={{ kind: 'session', id: session.id, label: name }}
          onClose={() => setViewingUsage(false)}
        />
      )}

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
        {filesOpen && (
          <SessionFiles
            sessionId={session.id}
            reloadSignal={live.fileChangesBySession[session.id] ?? 0}
          />
        )}
      </div>
    </div>
  );
}

function ReviewBoardChild({
  feature,
  active,
  onOpen,
}: {
  feature: Feature;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <div className={`session-card pr-review-child ${active ? 'is-active' : ''}`.trim()}>
      <div className="session-card-head">
        <button
          type="button"
          className="session-open"
          aria-current={active ? 'true' : undefined}
          onClick={onOpen}
          title={`Review Board for ${feature.name}`}
        >
          <span className="pr-review-child-icon" aria-hidden="true">
            <PrReviewIcon size={14} />
          </span>
          <span className="session-name">Review Board</span>
        </button>
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
  onOpenReviewBoard,
  onRenameSession,
  onRenameFeature,
  onDeleteFeature,
  onDeleteSession,
  onFeatureDragStart,
  onFeatureDragEnd,
  onNestFeature,
  draggingFeature,
  onStartReview,
  treeRevision,
  onMoveNode,
  childFeatures,
  renderChildFeature,
}: {
  feature: Feature;
  live: LiveState;
  activeSessionId: string | null;
  names: Record<string, string>;
  onOpenSession: (session: Session, label: string) => void;
  onOpenFeature: (feature: Feature) => void;
  onOpenReviewBoard: (feature: Feature) => void;
  onRenameSession: (sessionId: string, name: string) => void | Promise<void>;
  onRenameFeature: (feature: Feature, name: string) => Promise<void>;
  onDeleteFeature: (feature: Feature) => Promise<void>;
  onDeleteSession: (session: Session) => Promise<void>;
  onFeatureDragStart: (feature: Feature) => void;
  onFeatureDragEnd: () => void;
  /** Nests `moved` under this feature (drag a feature row onto another). */
  onNestFeature: (moved: Feature, parentFeatureId: string) => void | Promise<void>;
  /** The feature currently being dragged, if any, used to highlight nest targets. */
  draggingFeature: Feature | null;
  /** Starts the PR-review flow for this feature's repository, when it has one. */
  onStartReview?: () => void;
  treeRevision: number;
  onMoveNode: (input: MoveNodeInput) => Promise<void>;
  /** PR-review features nested under this one; rendered inside its subtree. */
  childFeatures?: Feature[];
  /** Renders a nested child feature (recursive), supplied by the parent list. */
  renderChildFeature?: (feature: Feature) => ReactNode;
}) {
  const api = useApi();
  const nodeStore = useNodeDragStore();
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [viewingUsage, setViewingUsage] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nodeDropTarget, setNodeDropTarget] = useState(false);
  const [featureDropTarget, setFeatureDropTarget] = useState(false);
  const [prPickerParent, setPrPickerParent] = useState<string | null | false>(
    false,
  );
  const [subcategoryParent, setSubcategoryParent] = useState<
    string | null | false
  >(false);
  const [subcategoryName, setSubcategoryName] = useState('');
  const sessions = useAsync(
    () => (expanded ? api.listSessions(feature.id) : Promise.resolve([])),
    [feature.id, expanded, treeRevision],
  );
  const groups = useAsync(
    () => (expanded ? api.listGroups(feature.id) : Promise.resolve([])),
    [feature.id, expanded, treeRevision],
  );
  const usage = useAsync(
    () => (expanded ? api.getFeatureUsage(feature.id) : Promise.resolve(null)),
    // Re-fetch the authoritative rollup whenever a new usage/session event is
    // observed so per-session metrics stay in lockstep with the status bar,
    // which refreshes on the same signal.
    [feature.id, expanded, liveSignal(live)],
  );

  const rows = (sessions.data ?? []).map((s) => mergeLive(s, live));
  // Stable per-session ordinals (by fetch order) so fallback names don't jump
  // around as the tree is rearranged.
  const ordinals = new Map(rows.map((s, index) => [s.id, index + 1]));
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

  async function runTreeAction(
    action: () => Promise<unknown>,
    failure: string,
  ) {
    setActionError(null);
    try {
      await action();
      groups.reload();
      sessions.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : failure);
    }
  }

  function handleMove(input: MoveNodeInput) {
    setActionError(null);
    onMoveNode(input).catch((error) =>
      setActionError(
        error instanceof Error ? error.message : 'Failed to move item.',
      ),
    );
  }

  function handleAddSubcategory(parentGroupId: string | null) {
    setActionError(null);
    setSubcategoryName('');
    setSubcategoryParent(parentGroupId);
  }

  function submitSubcategory() {
    if (subcategoryParent === false) {
      return;
    }
    const name = subcategoryName.trim();
    if (!name) {
      return;
    }
    const parentGroupId = subcategoryParent;
    setSubcategoryParent(false);
    setSubcategoryName('');
    void runTreeAction(
      () =>
        api.createGroup(feature.id, {
          parentGroupId,
          kind: 'subcategory',
          name,
        }),
      'Failed to create group.',
    );
  }

  function handleAttachPr(pull: PickedPull, parentGroupId: string | null) {
    setPrPickerParent(false);
    void runTreeAction(
      () =>
        api.createGroup(feature.id, {
          parentGroupId,
          kind: 'pr',
          name: pull.title,
          prNumber: pull.number,
          prUrl: pull.url,
        }),
      'Failed to attach pull request.',
    );
  }

  function handleRenameGroup(group: TreeGroup, name: string) {
    void runTreeAction(
      () => api.renameGroup(group.id, name),
      'Failed to rename group.',
    );
  }

  function handleDeleteGroup(group: TreeGroup) {
    void runTreeAction(
      () => api.deleteGroup(group.id),
      'Failed to delete group.',
    );
  }

  function handleNodeDrop() {
    const node = nodeStore?.dragging;
    if (!node) {
      return;
    }
    setNodeDropTarget(false);
    setExpanded(true);
    handleMove({
      type: node.type,
      id: node.id,
      targetFeatureId: feature.id,
      targetParentGroupId: null,
      targetIndex: APPEND_INDEX,
    });
    nodeStore?.setDragging(null);
  }

  const canAcceptNode = Boolean(nodeStore?.dragging);
  // A feature row also accepts another feature dragged onto it, nesting the
  // dropped feature beneath this one. Guard against self-drops and no-op
  // re-parenting onto the current parent.
  const canAcceptFeature = Boolean(
    draggingFeature &&
      draggingFeature.id !== feature.id &&
      (draggingFeature.parentFeatureId ?? null) !== feature.id,
  );

  function handleFeatureNestDrop() {
    if (!draggingFeature || !canAcceptFeature) {
      return;
    }
    setFeatureDropTarget(false);
    setExpanded(true);
    void onNestFeature(draggingFeature, feature.id);
  }

  return (
    <div className="tree-node" style={{ '--feature-accent': accent } as CSSProperties}>
      <div
        className={`tree-branch ${
          (nodeDropTarget && canAcceptNode) || (featureDropTarget && canAcceptFeature)
            ? 'is-drop-target'
            : ''
        }`.trim()}
        draggable={!editing}
        onDragStart={(event) => {
          event.stopPropagation();
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
          }
          beginDragFx(event.currentTarget);
          onFeatureDragStart(feature);
        }}
        onDragEnd={(event) => {
          endDragFx(event.currentTarget, event);
          onFeatureDragEnd();
        }}
        onDragOver={(event) => {
          if (canAcceptNode) {
            event.preventDefault();
            setNodeDropTarget(true);
          } else if (canAcceptFeature) {
            event.preventDefault();
            setFeatureDropTarget(true);
          }
        }}
        onDragLeave={() => {
          setNodeDropTarget(false);
          setFeatureDropTarget(false);
        }}
        onDrop={(event) => {
          if (canAcceptNode) {
            event.preventDefault();
            event.stopPropagation();
            handleNodeDrop();
            return;
          }
          if (canAcceptFeature) {
            event.preventDefault();
            event.stopPropagation();
            handleFeatureNestDrop();
          }
        }}
      >
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
          <ConfirmDialog
            title="Delete feature"
            icon={<WarningIcon />}
            confirmLabel="Delete feature"
            message={
              <>
                <p className="confirm-dialog-lead">
                  Delete <strong>{feature.name}</strong>?
                </p>
                <p className="confirm-dialog-note">
                  All of its sessions, transcripts and usage history will be
                  permanently removed. This can&apos;t be undone.
                </p>
              </>
            }
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              setConfirming(false);
              void onDeleteFeature(feature);
            }}
          />
        ) : null}
        <OverflowMenu
          label={`Actions for ${feature.name}`}
          actions={[
              {
                label: 'Rename',
                icon: <PencilIcon />,
                onSelect: startEditing,
              },
              {
                label: 'Add subcategory',
                icon: <FolderIcon size={14} />,
                onSelect: () => {
                  setExpanded(true);
                  handleAddSubcategory(null);
                },
              },
              ...(onStartReview
                ? [
                    {
                      label: 'Open a PR',
                      icon: <PullRequestIcon size={14} />,
                      onSelect: onStartReview,
                    },
                  ]
                : []),
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
                label: 'Usage breakdown',
                icon: <UsageIcon />,
                onSelect: () => setViewingUsage(true),
              },
              {
                label: 'Delete feature',
                icon: <TrashIcon />,
                danger: true,
                onSelect: () => setConfirming(true),
              },
            ]}
          />
      </div>

      <div className="feature-tags">
        <SkillChips scope="feature" targetId={feature.id} />
      </div>

      {viewingUsage && (
        <UsageBreakdownModal
          scope={{ kind: 'feature', id: feature.id, label: feature.name }}
          onClose={() => setViewingUsage(false)}
        />
      )}

      {expanded && (
        <div className="tree-children">
          {(feature.checkoutPath !== null || live.prReviews[feature.id]) && (
            <ReviewBoardChild
              feature={feature}
              active={false}
              onOpen={() => onOpenReviewBoard(feature)}
            />
          )}
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
          {sessions.loading && <SkeletonList rows={4} />}
          <ErrorText error={sessions.error} />
          <ErrorText error={groups.error} />
          {!sessions.loading &&
            rows.length === 0 &&
            (groups.data?.length ?? 0) === 0 &&
            (childFeatures?.length ?? 0) === 0 &&
            !creating &&
            !importing && (
              <EmptyState message="No sessions yet. Start one from the + above." />
            )}
          <FeatureTree
            featureId={feature.id}
            groups={groups.data ?? []}
            sessions={rows}
            ordinals={ordinals}
            onMove={handleMove}
            onAddSubcategory={handleAddSubcategory}
            onAttachPr={(parentGroupId) => setPrPickerParent(parentGroupId)}
            onRenameGroup={handleRenameGroup}
            onDeleteGroup={handleDeleteGroup}
            renderSession={(session, ordinal) => (
              <SessionRow
                session={session}
                ordinal={ordinal}
                customName={names[session.id]}
                active={session.id === activeSessionId}
                live={live}
                persisted={persistedBySession.get(session.id)}
                onOpen={() =>
                  onOpenSession(
                    session,
                    sessionDisplayName(names[session.id], ordinal),
                  )
                }
                onRename={(name) => handleRenameSession(session.id, name)}
                onDelete={() => handleDeleteSession(session)}
              />
            )}
          />
          <ErrorText error={actionError} />
          {childFeatures && childFeatures.length > 0 && (
            <div className="feature-child-features">
              {childFeatures.map((child) => (
                <Fragment key={child.id}>
                  {renderChildFeature?.(child)}
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}
      {prPickerParent !== false && feature.repoId && (
        <GroupPrPicker
          repoId={feature.repoId}
          onClose={() => setPrPickerParent(false)}
          onPick={(pull) => handleAttachPr(pull, prPickerParent)}
        />
      )}
      {subcategoryParent !== false && (
        <Modal
          title="New group"
          onClose={() => setSubcategoryParent(false)}
        >
          <div className="feature-form">
            <div className="field">
              <label htmlFor="new-subcategory-name">Name</label>
              <input
                id="new-subcategory-name"
                className="input"
                autoFocus
                value={subcategoryName}
                onChange={(event) => setSubcategoryName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    submitSubcategory();
                  }
                }}
                placeholder="e.g. Backend tasks"
              />
            </div>
            <div className="row modal-actions">
              <Button
                variant="ghost"
                onClick={() => setSubcategoryParent(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={submitSubcategory}
                disabled={!subcategoryName.trim()}
              >
                Create group
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * The "+" affordance on a repository row. Opens a small menu offering the two
 * ways to start work on a repo: reviewing an existing pull request or creating
 * a fresh feature. Closes on outside click, Escape, or after a choice.
 */
function RepoAddMenu({
  title,
  onNewFeature,
  onReviewPr,
}: {
  title: string;
  onNewFeature: () => void;
  onReviewPr: () => void;
}) {
  return (
    <OverflowMenu
      label={`Add to ${title}`}
      icon={<PlusIcon />}
      triggerClassName="tree-action"
      actions={[
        { label: 'Open a PR', icon: <TagIcon />, onSelect: onReviewPr },
        { label: 'New feature', icon: <PlusIcon />, onSelect: onNewFeature },
      ]}
    />
  );
}

/** A collapsible top-level repository (or the "No repository" group when
 * `repo` is null) that holds the features scoped to it. */
/**
 * A thin drop zone between feature rows. Dropping a dragged feature here moves
 * it into `repoId`'s group at position `index` (adjusting for the feature's own
 * position when reordered within the same group).
 */
function FeatureDropSlot({
  dragging,
  repoId,
  index,
  features,
  onMoveFeature,
}: {
  dragging: Feature | null;
  repoId: string | null;
  index: number;
  features: Feature[];
  onMoveFeature: (
    feature: Feature,
    targetRepoId: string | null,
    targetIndex: number,
  ) => void;
}) {
  const [over, setOver] = useState(false);
  if (!dragging) {
    return null;
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setOver(false);
    if (!dragging) {
      return;
    }
    const sameGroup = (dragging.repoId ?? null) === repoId;
    const currentIndex = features.findIndex((f) => f.id === dragging.id);
    const targetIndex =
      sameGroup && currentIndex !== -1 && currentIndex < index
        ? index - 1
        : index;
    onMoveFeature(dragging, repoId, targetIndex);
  }

  return (
    <div
      className={`tree-drop-slot ${over ? 'is-over' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      aria-hidden="true"
    />
  );
}

function RepoNode({
  repo,
  repositoryContext,
  features,
  defaultExpanded,
  live,
  activeSessionId,
  names,
  onOpenSession,
  onOpenFeature,
  onOpenReviewBoard,
  onOpenRepo,
  onRenameSession,
  onRenameFeature,
  onDeleteFeature,
  onDeleteSession,
  onAddFeature,
  onStartReview,
  onDeleteRepo,
  onContextUpdated,
  draggingFeature,
  onFeatureDragStart,
  onFeatureDragEnd,
  onMoveFeature,
  onNestFeature,
  treeRevision,
  onMoveNode,
}: {
  repo: Repository | null;
  repositoryContext?: RepositoryContext | null;
  features: Feature[];
  defaultExpanded: boolean;
  live: LiveState;
  activeSessionId: string | null;
  names: Record<string, string>;
  onOpenSession: (session: Session, label: string) => void;
  onOpenFeature: (feature: Feature) => void;
  onOpenReviewBoard: (feature: Feature) => void;
  onOpenRepo: (repo: Repository) => void;
  onRenameSession: (sessionId: string, name: string) => void | Promise<void>;
  onRenameFeature: (feature: Feature, name: string) => Promise<void>;
  onDeleteFeature: (feature: Feature) => Promise<void>;
  onDeleteSession: (session: Session) => Promise<void>;
  onAddFeature: (repoId: string | null) => void;
  onStartReview: (repo: Repository, parentFeatureId?: string | null) => void;
  onDeleteRepo: (repo: Repository) => void;
  onContextUpdated: (context: RepositoryContext) => void;
  draggingFeature: Feature | null;
  onFeatureDragStart: (feature: Feature) => void;
  onFeatureDragEnd: () => void;
  onMoveFeature: (
    feature: Feature,
    targetRepoId: string | null,
    targetIndex: number,
  ) => void;
  onNestFeature: (moved: Feature, parentFeatureId: string) => void | Promise<void>;
  treeRevision: number;
  onMoveNode: (input: MoveNodeInput) => Promise<void>;
}) {
  const repoId = repo?.id ?? null;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [confirming, setConfirming] = useState(false);
  const [viewingContext, setViewingContext] = useState(false);
  const [viewingUsage, setViewingUsage] = useState(false);
  const [headerDropTarget, setHeaderDropTarget] = useState(false);
  const title = repo ? repo.name : 'Scratchpad';
  const providerLabel = repo?.provider === 'azure-devops' ? 'Azure' : 'GitHub';
  // A feature dragged from another repository group can be dropped on this
  // repo's header to append it to the end of this group.
  const canAcceptDrop =
    draggingFeature !== null && (draggingFeature.repoId ?? null) !== repoId;

  // Nest PR-review features (opened from within a feature) under their parent.
  // Features whose parent is missing from this group fall back to top level so
  // a dangling parent (e.g. the parent was deleted) never hides them.
  const featureIds = new Set(features.map((f) => f.id));
  const childrenByParent = new Map<string, Feature[]>();
  for (const f of features) {
    const parentId = f.parentFeatureId ?? null;
    if (parentId && featureIds.has(parentId)) {
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(f);
      childrenByParent.set(parentId, siblings);
    }
  }
  const topFeatures = features.filter((f) => {
    const parentId = f.parentFeatureId ?? null;
    return !parentId || !featureIds.has(parentId);
  });

  const renderFeatureNode = (feature: Feature): ReactNode => (
    <FeatureNode
      feature={feature}
      live={live}
      activeSessionId={activeSessionId}
      names={names}
      onOpenSession={onOpenSession}
      onOpenFeature={onOpenFeature}
      onOpenReviewBoard={onOpenReviewBoard}
      onRenameSession={onRenameSession}
      onRenameFeature={onRenameFeature}
      onDeleteFeature={onDeleteFeature}
      onDeleteSession={onDeleteSession}
      onFeatureDragStart={onFeatureDragStart}
      onFeatureDragEnd={onFeatureDragEnd}
      onNestFeature={onNestFeature}
      draggingFeature={draggingFeature}
      onStartReview={
        repo ? () => onStartReview(repo, feature.id) : undefined
      }
      treeRevision={treeRevision}
      onMoveNode={onMoveNode}
      childFeatures={childrenByParent.get(feature.id) ?? []}
      renderChildFeature={renderFeatureNode}
    />
  );

  return (
    <div className={`repo-node ${repo ? '' : 'repo-node-orphan'}`.trim()}>
      <div
        className={`tree-branch repo-branch ${
          headerDropTarget && canAcceptDrop ? 'is-drop-target' : ''
        }`.trim()}
        onDragOver={(event) => {
          if (canAcceptDrop) {
            event.preventDefault();
            setHeaderDropTarget(true);
          }
        }}
        onDragLeave={() => setHeaderDropTarget(false)}
        onDrop={(event) => {
          if (!canAcceptDrop || !draggingFeature) {
            return;
          }
          event.preventDefault();
          setHeaderDropTarget(false);
          setExpanded(true);
          onMoveFeature(draggingFeature, repoId, features.length);
        }}
      >
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
        {repo ? (
          <button
            type="button"
            className="repo-branch-label repo-branch-label-button"
            title={`Open ${title} dashboard`}
            onClick={() => onOpenRepo(repo)}
          >
            {title}
          </button>
        ) : (
          <span
            className="repo-branch-label"
            title="Features without a repository"
          >
            {title}
          </span>
        )}
        {repo && <span className="repo-provider-chip">{providerLabel}</span>}
        {repo && (
          <RepositoryContextBadge
            context={repositoryContext}
            onClick={() => setViewingContext(true)}
          />
        )}
        {repo ? (
          <RepoAddMenu
            title={title}
            onNewFeature={() => {
              setExpanded(true);
              onAddFeature(repo.id);
            }}
            onReviewPr={() => onStartReview(repo)}
          />
        ) : (
          <button
            type="button"
            className="tree-action"
            title="New feature"
            aria-label={`New feature in ${title}`}
            onClick={() => {
              setExpanded(true);
              onAddFeature(null);
            }}
          >
            <PlusIcon />
          </button>
        )}
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
                  label: 'View context',
                  icon: <FilesIcon />,
                  onSelect: () => setViewingContext(true),
                },
                {
                  label: 'Usage breakdown',
                  icon: <UsageIcon />,
                  onSelect: () => setViewingUsage(true),
                },
                {
                  label: 'Agent readiness',
                  icon: <SkillsIcon />,
                  onSelect: () => (repo ? onOpenRepo(repo) : undefined),
                },
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

      {repo && viewingContext && repositoryContext && (
        <RepositoryContextViewer
          repo={repo}
          context={repositoryContext}
          onClose={() => setViewingContext(false)}
          onUpdated={onContextUpdated}
        />
      )}

      {repo && viewingUsage && (
        <UsageBreakdownModal
          scope={{ kind: 'repo', id: repo.id, label: repo.name }}
          onClose={() => setViewingUsage(false)}
        />
      )}

      {expanded && (
        <div className="tree-children repo-children">
          {topFeatures.length === 0 && (
            <EmptyState message="No features yet." />
          )}
          <FeatureDropSlot
            dragging={draggingFeature}
            repoId={repoId}
            index={0}
            features={topFeatures}
            onMoveFeature={onMoveFeature}
          />
          {topFeatures.map((feature, index) => (
            <Fragment key={feature.id}>
              {renderFeatureNode(feature)}
              <FeatureDropSlot
                dragging={draggingFeature}
                repoId={repoId}
                index={index + 1}
                features={topFeatures}
                onMoveFeature={onMoveFeature}
              />
            </Fragment>
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
  onOpenPrReview,
  onOpenReviewBoard,
  onOpenRepo,
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
  onOpenPrReview: (feature: Feature) => void;
  onOpenReviewBoard: (feature: Feature) => void;
  onOpenRepo: (repo: Repository) => void;
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
  const [reviewRepo, setReviewRepo] = useState<{
    repo: Repository;
    parentFeatureId: string | null;
  } | null>(null);
  const [adding, setAdding] = useState(false);
  const [targetRepoId, setTargetRepoId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [repositoryContexts, setRepositoryContexts] = useState<
    Record<string, RepositoryContext>
  >({});
  const [draggingFeature, setDraggingFeature] = useState<Feature | null>(null);
  const [treeRevision, setTreeRevision] = useState(0);

  /** Moves a session or group (possibly to a different feature) and refreshes
   * every expanded feature so both the source and target reflect the change. */
  async function moveNode(input: MoveNodeInput) {
    await api.moveNode(input);
    setTreeRevision((v) => v + 1);
  }

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

  async function moveFeature(
    feature: Feature,
    nextRepoId: string | null,
    targetIndex: number,
  ) {
    setDraggingFeature(null);
    try {
      await api.moveFeature({ id: feature.id, targetRepoId: nextRepoId, targetIndex });
    } finally {
      features.reload();
    }
  }

  async function nestFeature(moved: Feature, parentFeatureId: string) {
    setDraggingFeature(null);
    try {
      await api.moveFeature({
        id: moved.id,
        // The backend inherits the parent's repository, so targetRepoId here is
        // advisory; pass the moved feature's current repo to keep it stable if
        // the parent happens to be repo-less.
        targetRepoId: moved.repoId ?? null,
        targetIndex: APPEND_INDEX,
        targetParentFeatureId: parentFeatureId,
      });
    } finally {
      features.reload();
    }
  }

  async function deleteRepo(repo: Repository) {
    await api.deleteRepo(repo.id);
    repos.reload();
    features.reload();
  }

  const allFeatures = features.data ?? [];
  const repoList = repos.data ?? [];
  const repoIds = repoList.map((repo) => repo.id).join(',');

  useEffect(() => {
    if (!repoIds) {
      return;
    }
    let active = true;
    Promise.allSettled(
      repoList.map((repo) => api.getRepositoryContext(repo.id)),
    ).then((results) => {
      if (!active) {
        return;
      }
      setRepositoryContexts((current) => {
        const next = { ...current };
        results.forEach((result) => {
          if (result.status === 'fulfilled') {
            next[result.value.repositoryId] = result.value;
          }
        });
        return next;
      });
    });
    return () => {
      active = false;
    };
    // Fetch once when repository membership changes; SSE owns later updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, repoIds]);

  function contextFor(repo: Repository): RepositoryContext {
    const repoId = repo.id;
    const fetched = repositoryContexts[repoId];
    const streamed = live.repositoryContexts[repoId];
    if (!fetched && !streamed) {
      return {
        repositoryId: repoId,
        status: 'pending',
        content: null,
        sourceRevision: null,
        timestamps: {
          createdAt: repo.createdAt,
          updatedAt: repo.createdAt,
          generationStartedAt: null,
          generatedAt: null,
        },
        steps: [],
        failure: null,
      };
    }
    if (!fetched) return streamed!;
    if (!streamed) return fetched;
    return Date.parse(streamed.timestamps.updatedAt) >=
      Date.parse(fetched.timestamps.updatedAt)
      ? streamed
      : fetched;
  }

  function updateContext(context: RepositoryContext) {
    setRepositoryContexts((current) => ({
      ...current,
      [context.repositoryId]: context,
    }));
  }
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

      {reviewRepo && (
        <PrReviewPicker
          repo={reviewRepo.repo}
          parentFeatureId={reviewRepo.parentFeatureId}
          onClose={() => setReviewRepo(null)}
          onCreated={(feature) => {
            setReviewRepo(null);
            features.reload();
            onOpenPrReview(feature);
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
        {(repos.loading || features.loading) && <SkeletonList rows={5} />}
        <ErrorText error={repos.error} />
        <ErrorText error={features.error} />
        {!repos.loading &&
          !features.loading &&
          repoList.length === 0 &&
          orphanFeatures.length === 0 && (
            <EmptyState
              icon={<RepoIcon size={20} />}
              title="No repositories yet"
              description="Add a repository to organize sessions, features, and code reviews around your code."
              action={{
                label: 'Add repository',
                onClick: () => setAddingRepo(true),
              }}
            />
          )}
        <NodeDragStoreProvider>
        {repoList.map((repo) => (
          <RepoNode
            key={repo.id}
            repo={repo}
            repositoryContext={contextFor(repo)}
            features={allFeatures.filter((f) => f.repoId === repo.id)}
            defaultExpanded
            live={live}
            activeSessionId={activeSessionId}
            names={names}
            onOpenSession={onOpenSession}
            onOpenFeature={onOpenFeature}
            onOpenReviewBoard={onOpenReviewBoard}
            onOpenRepo={onOpenRepo}
            onRenameSession={onRenameSession}
            onRenameFeature={renameFeature}
            onDeleteFeature={deleteFeature}
            onDeleteSession={onDeleteSession}
            onAddFeature={openFeatureForm}
            onStartReview={(repo, parentFeatureId = null) =>
              setReviewRepo({ repo, parentFeatureId })
            }
            onDeleteRepo={deleteRepo}
            onContextUpdated={updateContext}
            draggingFeature={draggingFeature}
            onFeatureDragStart={setDraggingFeature}
            onFeatureDragEnd={() => setDraggingFeature(null)}
            onMoveFeature={moveFeature}            onNestFeature={nestFeature}
            treeRevision={treeRevision}
            onMoveNode={moveNode}
          />
        ))}
        {orphanFeatures.length > 0 && (
          <RepoNode
            repo={null}
            repositoryContext={null}
            features={orphanFeatures}
            defaultExpanded={repoList.length === 0}
            live={live}
            activeSessionId={activeSessionId}
            names={names}
            onOpenSession={onOpenSession}
            onOpenFeature={onOpenFeature}
            onOpenReviewBoard={onOpenReviewBoard}
            onOpenRepo={onOpenRepo}
            onRenameSession={onRenameSession}
            onRenameFeature={renameFeature}
            onDeleteFeature={deleteFeature}
            onDeleteSession={onDeleteSession}
            onAddFeature={openFeatureForm}
            onStartReview={(repo, parentFeatureId = null) =>
              setReviewRepo({ repo, parentFeatureId })
            }
            onDeleteRepo={deleteRepo}
            onContextUpdated={updateContext}
            draggingFeature={draggingFeature}
            onFeatureDragStart={setDraggingFeature}
            onFeatureDragEnd={() => setDraggingFeature(null)}
            onMoveFeature={moveFeature}            onNestFeature={nestFeature}
            treeRevision={treeRevision}
            onMoveNode={moveNode}
          />
        )}
        </NodeDragStoreProvider>
      </div>

      <div className="explorer-footer">
        <GithubStatusBadge />
        <AzureStatusBadge />
      </div>
    </div>
  );
}

