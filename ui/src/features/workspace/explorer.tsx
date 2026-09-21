import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { usePersistentState } from '../../hooks/use-persistent-state.js';
import { ApiError } from '../../lib/api.js';
import type { LiveState } from '../../lib/stream.js';
import {
  liveSignal,
  mergeLive,
  resolveSessionMetrics,
  sessionLiveTotals,
} from '../../lib/stream.js';
import type {
  Feature,
  MoveNodeInput,
  Repository,
  RepositoryContext,
  Session,
  SessionBreakdown,
  TreeGroup,
  AttachedAgent,
} from '../../lib/types.js';
import { formatAic, formatCompactNumber, formatDuration } from '../../lib/format.js';
import { featureColor } from '../../lib/feature-color.js';
import { sessionDisplayName } from '../../lib/session-names.js';
import { sessionDotClass } from '../../lib/session-status.js';
import { Button, ConfirmDialog, DragHandle, EmptyState, ErrorText, Modal } from '../../components/ui.js';
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
  MoveIcon,
  ImportIcon,
  PencilIcon,
  PlusIcon,
  PullRequestIcon,
  RepoIcon,
  SkillsIcon,
  TagIcon,
  TimeIcon,
  TrashIcon,
  UsageIcon,
  WarningIcon,
} from '../../components/icons.js';
import { AgentIcon } from '../../agent-host/agent-icon.js';
import {
  blockedMoveTargets,
  featureMoveTargets,
  type FeatureMoveTarget,
  type MovableGroup,
} from '../../lib/feature-move-targets.js';
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

/**
 * How long a drag must hover a collapsed feature row before it opens. Long
 * enough that passing over a row on the way somewhere else does not disturb
 * the tree, short enough to feel like a direct response.
 */
const HOVER_EXPAND_MS = 600;

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
  const [filesOpen, setFilesOpen] = usePersistentState(
    `explorer.session.${session.id}.files`,
    false,
  );
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
          {totals ? (
            <>
              <span className="metric metric-credits">
                <UsageIcon size={11} /> {formatAic(totals.nanoAiu)}
              </span>
              <span className="metric">
                <ArrowUpIcon size={11} /> {formatCompactNumber(totals.inputTokens)}
              </span>
              <span className="metric">
                <ArrowDownIcon size={11} /> {formatCompactNumber(totals.outputTokens)}
              </span>
            </>
          ) : (
            <span className="metric" title="Waiting for authoritative saved usage; live history is incomplete">Usage pending</span>
          )}
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

function AttachedAgents({
  feature,
  expanded,
  reviewSignal,
  refreshSignal,
  onOpenAgent,
}: {
  feature: Feature;
  expanded: boolean;
  /** Changes when the feature's PR review updates, to re-poll attachments. */
  reviewSignal: unknown;
  /** Bumped when an agent is attached elsewhere (the catalogue modal), to re-poll. */
  refreshSignal: unknown;
  onOpenAgent: (feature: Feature, attached: AttachedAgent) => void;
}) {
  const api = useApi();
  const [attached, setAttached] = useState<AttachedAgent[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void api
      .listFeatureAgents(feature.id)
      .then(setAttached)
      .catch(() => setAttached([]));
  }, [api, feature.id]);

  useEffect(() => {
    if (!expanded) {
      return;
    }
    reload();
  }, [expanded, reload, reviewSignal, refreshSignal]);

  async function detach(attachmentId: string) {
    setBusy(true);
    try {
      await api.detachAgent(attachmentId);
      reload();
    } catch {
      // Detach failed; keep the agent shown.
    } finally {
      setBusy(false);
    }
  }

  if (attached.length === 0) {
    return null;
  }

  return (
    <div className="attached-agents">
      <div className="attached-agents-label">
        <SkillsIcon size={12} />
        <span>Agents</span>
        <span className="attached-agents-count">{attached.length}</span>
      </div>
      {attached.map((entry) => (
        <div
          key={entry.attachment.id}
          className="session-card pr-review-child attached-agent-row"
        >
          <div className="session-card-head">
            <button
              type="button"
              className="session-open"
              onClick={() => onOpenAgent(feature, entry)}
              title={`${entry.manifest.title} for ${feature.name}`}
            >
              <span className="pr-review-child-icon" aria-hidden="true">
                <AgentIcon icon={entry.manifest.icon} size={14} />
              </span>
              <span className="session-name">{entry.manifest.title}</span>
            </button>
            <button
              type="button"
              className="tree-action"
              title={`Detach ${entry.manifest.title}`}
              aria-label={`Detach ${entry.manifest.title}`}
              disabled={busy}
              onClick={() => void detach(entry.attachment.id)}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A modal that presents the agent catalogue for a feature. Every installed
 * agent is listed with its eligibility for this feature; attachable ones can be
 * added in place, ineligible ones show why (e.g. a missing prerequisite).
 */
function AddAgentModal({
  feature,
  onClose,
  onAttached,
}: {
  feature: Feature;
  onClose: () => void;
  onAttached: () => void;
}) {
  const api = useApi();
  const { data, loading, error, reload } = useAsync(
    () => api.listAvailableAgents(feature.id),
    [feature.id],
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);

  async function add(agentId: string) {
    setBusyId(agentId);
    setAttachError(null);
    try {
      await api.attachAgent(feature.id, agentId);
      onAttached();
      onClose();
    } catch (err) {
      setAttachError(
        err instanceof Error ? err.message : 'Could not add the agent.',
      );
      reload();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal title={`Add agent to ${feature.name}`} onClose={onClose}>
      <div className="agent-catalog">
        {loading && <SkeletonList rows={3} />}
        <ErrorText error={error} />
        {data && data.length === 0 && (
          <EmptyState message="No agents are installed." />
        )}
        {data?.map((entry) => (
          <div
            key={entry.manifest.id}
            className={`agent-catalog-item${entry.attachable ? '' : ' is-unavailable'}`}
          >
            <span className="agent-catalog-icon" aria-hidden="true">
              <AgentIcon icon={entry.manifest.icon} size={18} />
            </span>
            <div className="agent-catalog-body">
              <span className="agent-catalog-title">{entry.manifest.title}</span>
              <span className="agent-catalog-desc">
                {entry.manifest.description}
              </span>
              {!entry.attachable && (
                <span className="agent-catalog-reason">
                  {entry.reason ??
                    `Requires ${entry.manifest.prerequisiteLabel}.`}
                </span>
              )}
            </div>
            <Button
              variant="secondary"
              disabled={!entry.attachable || busyId !== null}
              loading={busyId === entry.manifest.id}
              onClick={() => void add(entry.manifest.id)}
              ariaLabel={`Add ${entry.manifest.title} to ${feature.name}`}
            >
              Add
            </Button>
          </div>
        ))}
        <ErrorText error={attachError} />
      </div>
    </Modal>
  );
}

function FeatureNode({
  feature,
  live,
  activeSessionId,
  names,
  onOpenSession,
  onOpenFeature,
  onOpenAgent,
  onRenameSession,
  onRenameFeature,
  onDeleteFeature,
  onDeleteSession,
  onFeatureDragStart,
  onFeatureDragEnd,
  onNestFeature,
  onRequestMove,
  onMoveFeatureIntoGroup,
  draggingFeature,
  canNestInto,
  onStartReview,
  treeRevision,
  onMoveNode,
  childFeatures,
  renderChildFeature,
  renderGroupFeatures,
  onCreateFeatureInGroup,
}: {
  feature: Feature;
  live: LiveState;
  activeSessionId: string | null;
  names: Record<string, string>;
  onOpenSession: (session: Session, label: string) => void;
  onOpenFeature: (feature: Feature) => void;
  onOpenAgent: (feature: Feature, attached: AttachedAgent) => void;
  onRenameSession: (sessionId: string, name: string) => void | Promise<void>;
  onRenameFeature: (feature: Feature, name: string) => Promise<void>;
  onDeleteFeature: (feature: Feature) => Promise<void>;
  onDeleteSession: (session: Session) => Promise<void>;
  onFeatureDragStart: (feature: Feature) => void;
  onFeatureDragEnd: () => void;
  /** Nests `moved` under this feature (drag a feature row onto another). */
  onNestFeature: (moved: Feature, parentFeatureId: string) => void | Promise<void>;
  /** Opens the destination picker for this feature (drag-free relocation). */
  onRequestMove: (feature: Feature) => void;
  /** Moves a dragged feature into one of this feature's subcategory folders. */
  onMoveFeatureIntoGroup: (
    moved: Feature,
    parentGroupId: string,
  ) => void | Promise<void>;
  /** The feature currently being dragged, if any, used to highlight nest targets. */
  draggingFeature: Feature | null;
  /**
   * Whether the dragged feature may be nested under `featureId`. Descendants of
   * the dragged feature are illegal destinations (the backend rejects the cycle),
   * so they must not light up as drop targets at all.
   */
  canNestInto: (featureId: string) => boolean;
  /** Starts the PR-review flow for this feature's repository, when it has one. */
  onStartReview?: () => void;
  treeRevision: number;
  onMoveNode: (input: MoveNodeInput) => Promise<void>;
  /** PR-review features nested under this one; rendered inside its subtree. */
  childFeatures?: Feature[];
  /** Renders a nested child feature (recursive), supplied by the parent list. */
  renderChildFeature?: (feature: Feature) => ReactNode;
  /** Renders the features that live inside a subcategory group (by group id). */
  renderGroupFeatures?: (groupId: string) => ReactNode;
  /** Creates a new feature inside a subcategory group of this feature's repo. */
  onCreateFeatureInGroup?: (
    repoId: string | null,
    parentGroupId: string,
    name: string,
  ) => Promise<void>;
}) {
  const api = useApi();
  const nodeStore = useNodeDragStore();
  const [expanded, setExpanded] = usePersistentState(
    `explorer.feature.${feature.id}.expanded`,
    false,
  );
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [viewingUsage, setViewingUsage] = useState(false);
  const [addingAgent, setAddingAgent] = useState(false);
  const [agentRefresh, setAgentRefresh] = useState(0);
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
  const [featureGroupParent, setFeatureGroupParent] = useState<string | false>(
    false,
  );
  const [featureGroupName, setFeatureGroupName] = useState('');
  const [featureGroupBusy, setFeatureGroupBusy] = useState(false);
  const sessions = useAsync(
    () => (expanded ? api.listSessions(feature.id) : Promise.resolve([])),
    [feature.id, expanded, treeRevision, live.sessionRevision],
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

  function handleNewFeatureInGroup(parentGroupId: string) {
    setActionError(null);
    setFeatureGroupName('');
    setFeatureGroupParent(parentGroupId);
  }

  async function submitNewFeatureInGroup() {
    if (featureGroupParent === false || !onCreateFeatureInGroup) {
      return;
    }
    const name = featureGroupName.trim();
    if (!name) {
      return;
    }
    const parentGroupId = featureGroupParent;
    setFeatureGroupBusy(true);
    try {
      await onCreateFeatureInGroup(feature.repoId, parentGroupId, name);
      setFeatureGroupParent(false);
      setFeatureGroupName('');
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Failed to create feature.',
      );
    } finally {
      setFeatureGroupBusy(false);
    }
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
      (draggingFeature.parentFeatureId ?? null) !== feature.id &&
      canNestInto(feature.id),
  );

  // Reveal sub-categories while a drag hovers a collapsed row. Without this a
  // nested destination is unreachable by dragging at all: its parent has to be
  // open for the child row to exist, and a drag cannot click the chevron.
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHoverExpand = (): void => {
    if (expandTimer.current !== null) {
      clearTimeout(expandTimer.current);
      expandTimer.current = null;
    }
  };
  const scheduleHoverExpand = (): void => {
    if (expanded || expandTimer.current !== null) {
      return;
    }
    expandTimer.current = setTimeout(() => {
      expandTimer.current = null;
      setExpanded(true);
    }, HOVER_EXPAND_MS);
  };
  useEffect(() => cancelHoverExpand, []);

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
            scheduleHoverExpand();
          } else if (draggingFeature) {
            // Not a legal destination itself, but its subtree may hold one.
            scheduleHoverExpand();
          }
        }}
        onDragLeave={() => {
          cancelHoverExpand();
          setNodeDropTarget(false);
          setFeatureDropTarget(false);
        }}
        onDrop={(event) => {
          cancelHoverExpand();
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
        <DragHandle label={`Drag to move ${feature.name}`} />
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
        <div className="tree-branch-trail">
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
              {
                label: 'Move to…',
                icon: <MoveIcon size={14} />,
                onSelect: () => onRequestMove(feature),
              },
              ...(onStartReview
                ? [
                    {
                      label: 'Open Pull Request',
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
                label: 'Add agent',
                icon: <AgentIcon icon="add" size={14} />,
                onSelect: () => {
                  setExpanded(true);
                  setAddingAgent(true);
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
        </div>
        {confirming ? (
          <ConfirmDialog
            title="Delete feature"
            icon={<WarningIcon />}
            confirmLabel="Delete feature"
            busy={deleting}
            error={deleteError}
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
            onCancel={() => {
              setConfirming(false);
              setDeleteError(null);
            }}
            onConfirm={() => {
              setDeleting(true);
              setDeleteError(null);
              void (async () => {
                try {
                  await onDeleteFeature(feature);
                  setConfirming(false);
                } catch (error) {
                  setDeleteError(
                    error instanceof Error
                      ? error.message
                      : 'Could not delete the feature.',
                  );
                } finally {
                  setDeleting(false);
                }
              })();
            }}
          />
        ) : null}
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

      {addingAgent && (
        <AddAgentModal
          feature={feature}
          onClose={() => setAddingAgent(false)}
          onAttached={() => {
            setExpanded(true);
            setAgentRefresh((n) => n + 1);
          }}
        />
      )}

      {expanded && (
        <div className="tree-children">
          <AttachedAgents
            feature={feature}
            expanded={expanded}
            reviewSignal={live.prReviews[feature.id]}
            refreshSignal={agentRefresh}
            onOpenAgent={onOpenAgent}
          />
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
            renderGroupFeatures={renderGroupFeatures}
            draggingFeature={draggingFeature}
            canNestInto={canNestInto}
            onMoveFeatureIntoGroup={onMoveFeatureIntoGroup}
            onNewFeature={
              onCreateFeatureInGroup ? handleNewFeatureInGroup : undefined
            }
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
      {featureGroupParent !== false && (
        <Modal
          title="New feature"
          onClose={() => setFeatureGroupParent(false)}
        >
          <div className="feature-form">
            <div className="field">
              <label htmlFor="new-group-feature-name">Name</label>
              <input
                id="new-group-feature-name"
                className="input"
                autoFocus
                value={featureGroupName}
                onChange={(event) => setFeatureGroupName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void submitNewFeatureInGroup();
                  }
                }}
                placeholder="e.g. Checkout redesign"
              />
            </div>
            <div className="row modal-actions">
              <Button
                variant="ghost"
                onClick={() => setFeatureGroupParent(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void submitNewFeatureInGroup()}
                disabled={!featureGroupName.trim() || featureGroupBusy}
              >
                {featureGroupBusy ? 'Creating…' : 'Create feature'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
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
        { label: 'Open Pull Request', icon: <TagIcon />, onSelect: onReviewPr },
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
  onOpenAgent,
  onOpenRepo,
  onRenameSession,
  onRenameFeature,
  onDeleteFeature,
  onDeleteSession,
  onAddFeature,
  onStartReview,
  onDeleteRepo,
  onRemoveScratchpad,
  onContextUpdated,
  draggingFeature,
  canNestInto,
  onFeatureDragStart,
  onFeatureDragEnd,
  onMoveFeature,
  onNestFeature,
  onMoveFeatureIntoGroup,
  onRequestMove,
  treeRevision,
  onMoveNode,
  onCreateFeatureInGroup,
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
  onOpenAgent: (feature: Feature, attached: AttachedAgent) => void;
  onOpenRepo: (repo: Repository) => void;
  onRenameSession: (sessionId: string, name: string) => void | Promise<void>;
  onRenameFeature: (feature: Feature, name: string) => Promise<void>;
  onDeleteFeature: (feature: Feature) => Promise<void>;
  onDeleteSession: (session: Session) => Promise<void>;
  onAddFeature: (repoId: string | null) => void;
  onStartReview: (repo: Repository, parentFeatureId?: string | null) => void;
  onDeleteRepo: (repo: Repository) => void;
  onRemoveScratchpad?: () => void | Promise<void>;
  onContextUpdated: (context: RepositoryContext) => void;
  draggingFeature: Feature | null;
  /** Whether the dragged feature may be nested under the given feature id. */
  canNestInto: (featureId: string) => boolean;
  onFeatureDragStart: (feature: Feature) => void;
  onFeatureDragEnd: () => void;
  onMoveFeature: (
    feature: Feature,
    targetRepoId: string | null,
    targetIndex: number,
  ) => void;
  onNestFeature: (moved: Feature, parentFeatureId: string) => void | Promise<void>;
  onMoveFeatureIntoGroup: (
    moved: Feature,
    parentGroupId: string,
  ) => void | Promise<void>;
  onRequestMove: (feature: Feature) => void;
  treeRevision: number;
  onMoveNode: (input: MoveNodeInput) => Promise<void>;
  onCreateFeatureInGroup: (
    repoId: string | null,
    parentGroupId: string,
    name: string,
  ) => Promise<void>;
}) {
  const repoId = repo?.id ?? null;
  const [expanded, setExpanded] = usePersistentState(
    `explorer.repo.${repoId ?? 'none'}.expanded`,
    defaultExpanded,
  );
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
  // Features placed inside a subcategory folder render within that folder (via
  // renderGroupFeatures), not at the repository top level.
  const membersByGroup = new Map<string, Feature[]>();
  for (const f of features) {
    const groupId = f.parentGroupId ?? null;
    if (groupId) {
      const members = membersByGroup.get(groupId) ?? [];
      members.push(f);
      membersByGroup.set(groupId, members);
    }
  }
  const orderMembers = (members: Feature[]): Feature[] =>
    [...members].sort(
      (l, r) =>
        (l.orderIndex ?? 0) - (r.orderIndex ?? 0) ||
        l.createdAt.localeCompare(r.createdAt),
    );
  const topFeatures = features.filter((f) => {
    if (f.parentGroupId) {
      return false;
    }
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
      onOpenAgent={onOpenAgent}
      onRenameSession={onRenameSession}
      onRenameFeature={onRenameFeature}
      onDeleteFeature={onDeleteFeature}
      onDeleteSession={onDeleteSession}
      onFeatureDragStart={onFeatureDragStart}
      onFeatureDragEnd={onFeatureDragEnd}
      onNestFeature={onNestFeature}
      onMoveFeatureIntoGroup={onMoveFeatureIntoGroup}
      onRequestMove={onRequestMove}
      draggingFeature={draggingFeature}
      canNestInto={canNestInto}
      onStartReview={
        repo ? () => onStartReview(repo, feature.id) : undefined
      }
      treeRevision={treeRevision}
      onMoveNode={onMoveNode}
      childFeatures={childrenByParent.get(feature.id) ?? []}
      renderChildFeature={renderFeatureNode}
      renderGroupFeatures={(groupId) => {
        const members = membersByGroup.get(groupId);
        return members ? orderMembers(members).map(renderFeatureNode) : null;
      }}
      onCreateFeatureInGroup={onCreateFeatureInGroup}
    />
  );

  return (
    <div className={`repo-node ${repo ? '' : 'repo-node-orphan'}`.trim()}>
      <div
        className={`tree-branch repo-branch ${
          headerDropTarget && canAcceptDrop ? 'is-drop-target' : ''
        } ${confirming ? 'is-actions-open' : ''}`.trim()}
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
        {repo && (
          <RepositoryContextBadge
            context={repositoryContext}
            onClick={() => setViewingContext(true)}
          />
        )}
        <div className="tree-branch-trail">
          {repo && <span className="repo-provider-chip">{providerLabel}</span>}
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
          {!repo &&
            onRemoveScratchpad &&
            (confirming ? (
              <span
                className="row-confirm"
                role="group"
                aria-label="Confirm remove"
              >
                <button
                  type="button"
                  className="row-confirm-yes"
                  title="Confirm remove"
                  aria-label={`Confirm remove ${title}`}
                  onClick={() => {
                    setConfirming(false);
                    void onRemoveScratchpad();
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
                    label: 'Remove Scratchpad',
                    icon: <TrashIcon />,
                    danger: true,
                    onSelect: () => setConfirming(true),
                  },
                ]}
              />
            ))}
          {repo &&
            (confirming ? (
              <span
                className="row-confirm"
                role="group"
                aria-label="Confirm delete"
              >
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
  onOpenAgent,
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
  onOpenAgent: (feature: Feature, attached: AttachedAgent) => void;
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
  const [moveError, setMoveError] = useState<string | null>(null);
  const [movingFeature, setMovingFeature] = useState<Feature | null>(null);
  const [treeRevision, setTreeRevision] = useState(0);

  // Subcategory groups across every feature, loaded lazily only while the move
  // dialog is open so the destination picker can offer folders as targets.
  const moveGroups = useAsync(async () => {
    if (!movingFeature) {
      return [] as MovableGroup[];
    }
    const lists = await Promise.all(
      (features.data ?? []).map((f) =>
        api.listGroups(f.id).then((groups) =>
          groups.map((g) => ({
            id: g.id,
            name: g.name,
            featureId: f.id,
            parentGroupId: g.parentGroupId ?? null,
            kind: g.kind,
          })),
        ),
      ),
    );
    return lists.flat();
  }, [movingFeature, treeRevision]);

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

  async function removeScratchpad() {
    const orphans = allFeatures.filter(
      (f) => !f.repoId || !repoList.some((r) => r.id === f.repoId),
    );
    for (const feature of orphans) {
      await deleteFeature(feature);
    }
  }

  async function createFeatureInGroup(
    repoId: string | null,
    parentGroupId: string,
    featureName: string,
  ) {
    await api.createFeature({
      name: featureName,
      description: '',
      repoId,
      parentGroupId,
    });
    features.reload();
  }

  async function renameFeature(feature: Feature, next: string) {
    await onRenameFeature(feature, next);
    features.reload();
  }

  async function deleteFeature(feature: Feature) {
    // Deleting a feature first cancels any work it still owns (an in-flight
    // review or metasession). That cancellation is asynchronous: the backend
    // aborts the work, then waits a few seconds for it to confirm stopped and
    // otherwise answers 409 ("blocked until all owned work has stopped"). The
    // cancellation *has* already been requested, so a slow-to-abort operation
    // used to force the user to click delete a second time. Retry the delete
    // until the aborted work settles so a single confirmation is enough.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await onDeleteFeature(feature);
        break;
      } catch (error) {
        const stillStopping =
          error instanceof ApiError &&
          error.status === 409 &&
          Date.now() < deadline;
        if (!stillStopping) {
          features.reload();
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    features.reload();
  }

  async function moveFeature(
    feature: Feature,
    nextRepoId: string | null,
    targetIndex: number,
  ) {
    setDraggingFeature(null);
    setMoveError(null);
    try {
      await api.moveFeature({ id: feature.id, targetRepoId: nextRepoId, targetIndex });
    } catch (error) {
      setMoveError(
        error instanceof Error ? error.message : 'Could not move the feature.',
      );
    } finally {
      features.reload();
    }
  }

  async function moveFeatureTo(moved: Feature, target: FeatureMoveTarget) {
    setMoveError(null);
    try {
      await api.moveFeature({
        id: moved.id,
        targetRepoId: target.repoId,
        targetIndex: APPEND_INDEX,
        targetParentFeatureId: target.parentGroupId
          ? null
          : target.parentFeatureId,
        targetParentGroupId: target.parentGroupId ?? null,
      });
    } catch (error) {
      setMoveError(
        error instanceof Error ? error.message : 'Could not move the feature.',
      );
    } finally {
      features.reload();
    }
  }

  async function nestFeature(moved: Feature, parentFeatureId: string) {
    setDraggingFeature(null);
    setMoveError(null);
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
    } catch (error) {
      // A rejected move used to disappear entirely: the tree simply snapped
      // back and the reason (a nesting cycle, a missing target) was never
      // shown, which read as "dragging into a sub-category does not work".
      setMoveError(
        error instanceof Error ? error.message : 'Could not move the feature.',
      );
    } finally {
      features.reload();
    }
  }

  // Drag a feature row onto a subcategory folder header to place it inside that
  // folder. The folder's owning feature supplies repo inheritance and the cycle
  // check on the backend, so targetRepoId here is advisory.
  async function moveFeatureIntoGroup(moved: Feature, parentGroupId: string) {
    setDraggingFeature(null);
    setMoveError(null);
    try {
      await api.moveFeature({
        id: moved.id,
        targetRepoId: moved.repoId ?? null,
        targetIndex: APPEND_INDEX,
        targetParentFeatureId: null,
        targetParentGroupId: parentGroupId,
      });
    } catch (error) {
      setMoveError(
        error instanceof Error ? error.message : 'Could not move the feature.',
      );
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

  // A feature cannot be nested inside itself or its own descendants — the
  // backend rejects the cycle. Computing the illegal set here keeps those rows
  // from lighting up as drop targets at all, so a drag never ends in a failure
  // the user could not have predicted.
  const blockedNestTargets = useMemo(
    () =>
      draggingFeature
        ? blockedMoveTargets(allFeatures, draggingFeature.id)
        : new Set<string>(),
    [allFeatures, draggingFeature],
  );
  const canNestInto = useCallback(
    (featureId: string) => !blockedNestTargets.has(featureId),
    [blockedNestTargets],
  );

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

      {movingFeature && (
        <Modal
          title={`Move ${movingFeature.name}`}
          onClose={() => setMovingFeature(null)}
        >
          <div className="stack">
            <p className="muted">
              Pick where this feature folder should live. Nested destinations
              are listed in full, so you don&apos;t have to drag onto a row that
              may not even be visible.
            </p>
            {(() => {
              const targets = featureMoveTargets(
                allFeatures,
                movingFeature,
                repoList,
                moveGroups.data ?? [],
              );
              if (targets.length === 0) {
                return (
                  <EmptyState
                    icon={<MoveIcon size={20} />}
                    title="Nowhere to move it"
                    description="Every other place is either this feature itself or one of the folders inside it."
                  />
                );
              }
              return (
                <ul className="move-target-list">
                  {targets.map((target) => (
                    <li
                      key={`${target.repoId ?? 'none'}:${
                        target.parentFeatureId ?? 'root'
                      }:${target.parentGroupId ?? 'nogroup'}`}
                    >
                      <button
                        type="button"
                        className="move-target"
                        style={{ paddingLeft: `${8 + target.depth * 14}px` }}
                        onClick={() => {
                          const moved = movingFeature;
                          setMovingFeature(null);
                          void moveFeatureTo(moved, target);
                        }}
                      >
                        {target.label}
                      </button>
                    </li>
                  ))}
                </ul>
              );
            })()}
          </div>
        </Modal>
      )}

      <div className="explorer-body">
        {(repos.loading || features.loading) && <SkeletonList rows={5} />}
        <ErrorText error={repos.error} />
        <ErrorText error={features.error} />
        <ErrorText error={moveError} />
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
            onOpenAgent={onOpenAgent}
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
            canNestInto={canNestInto}
            onFeatureDragStart={setDraggingFeature}
            onFeatureDragEnd={() => setDraggingFeature(null)}
            onMoveFeature={moveFeature}
            onNestFeature={nestFeature}
            onMoveFeatureIntoGroup={moveFeatureIntoGroup}
            onRequestMove={setMovingFeature}
            treeRevision={treeRevision}
            onMoveNode={moveNode}
            onCreateFeatureInGroup={createFeatureInGroup}
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
            onOpenAgent={onOpenAgent}
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
            canNestInto={canNestInto}
            onFeatureDragStart={setDraggingFeature}
            onFeatureDragEnd={() => setDraggingFeature(null)}
            onMoveFeature={moveFeature}
            onNestFeature={nestFeature}
            onMoveFeatureIntoGroup={moveFeatureIntoGroup}
            onRequestMove={setMovingFeature}
            treeRevision={treeRevision}
            onMoveNode={moveNode}
            onCreateFeatureInGroup={createFeatureInGroup}
            onRemoveScratchpad={removeScratchpad}
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
