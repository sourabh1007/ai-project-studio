import { useAutomationReadiness } from '../../app/automation-readiness.js';
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from 'react';
import { useApi } from '../../app/api-context.js';
import { reviewBoardRunStore } from '../review-board-page/review-board-run-store.js';
import { useAsync } from '../../hooks/use-async.js';
import { usePersistentState } from '../../hooks/use-persistent-state.js';
import { withOperationKey } from '../../lib/operation-keys.js';
import type { LiveState } from '../../lib/stream.js';
import {
  mergeLive,
  resolveSessionMetrics,
  sessionLiveTotals,
} from '../../lib/stream.js';
import { featureUsageRevision, workspaceUsageRevision } from '../../lib/feature-usage-freshness.js';
import { useUsageSummary } from '../../hooks/use-usage-summary.js';
import type {
  Feature,
  FeatureDeletionWorktree,
  MoveNodeInput,
  Repository,
  RepositoryContext,
  Session,
  SessionBreakdown,
  TreeGroup,
  AttachedAgent,
  UsageSummary,
  UsageSummaryNode,
} from '../../lib/types.js';
import { formatAic, formatCost, formatDuration, formatTokens } from '../../lib/format.js';
import { featureColor } from '../../lib/feature-color.js';
import { sessionWorkTitle } from '../../lib/session-names.js';
import { sessionDotClass } from '../../lib/session-status.js';
import { providerLabel } from '../../lib/meta-model.js';
import { Button, ConfirmDialog, DragHandle, EmptyState, ErrorText, Modal } from '../../components/ui.js';
import { BrandedLoader, SkeletonList } from '../../components/loading.js';
import {
  ChevronIcon,
  CheckIcon,
  CloseIcon,
  CollapseSidebarIcon,
  FilesIcon,
  FolderIcon,
  MoveIcon,
  ImportIcon,
  LocateIcon,
  PencilIcon,
  PlusIcon,
  PullRequestIcon,
  RepoIcon,
  SessionIcon,
  SkillsIcon,
  TagIcon,
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
  ExplorerRevealContext,
  FeatureTree,
  NodeDragStoreProvider,
  useNodeDragStore,
} from './feature-tree.js';
import { GroupPrPicker, type PickedPull } from './group-pr-picker.js';
import { RepoPicker } from './repo-picker.js';
import { PrReviewPicker } from './pr-review-picker.js';
import { bulkReviewName } from './bulk-pr-checkout.js';
import { prImportStore } from '../../lib/pr-import-store.js';
import { featureDeletionStore } from '../../lib/feature-deletion-store.js';
import { usePrImportEvents } from '../../hooks/use-pr-imports.js';
import { PrImportStatus } from './pr-import-status.js';
import { GithubStatusBadge } from '../github/github-status.js';
import { AzureStatusBadge } from '../azure/azure-status.js';
import type { WorkspaceTab } from './workspace-tabs.js';
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
const UsageSummaryContext = createContext<{
  snapshot: UsageSummary | null;
  invalidate: () => void;
} | null>(null);

function UsageBadge({ node, label, onOpenEvents }: {
  node: UsageSummaryNode | undefined;
  label: string;
  onOpenEvents: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!node) return null;
  const { totals, state } = node;
  const credits = state === 'partial'
    ? `>= ${formatAic(totals.knownNanoAiu ?? 0)}`
    : state === 'complete' ? formatAic(totals.nanoAiu) : 'n/a';
  const tokens = totals.inputTokens + totals.outputTokens;
  const status = state === 'none' ? 'No sessions'
    : state === 'empty' ? 'Awaiting usage'
    : state === 'complete' ? 'Reported'
    : state === 'partial' ? 'Partial: known lower bound' : 'Charges not reported';
  return <>
    <button type="button" className="tree-action tree-usage-badge"
      aria-label={`View ${label} usage`}
      aria-haspopup="dialog" aria-expanded={open}
      aria-description={`${credits} AI credits, ${formatTokens(tokens)} tokens. ${status}.`}
      title={`${label}, including nested items: ${credits} AI credits, ${formatTokens(tokens)} tokens. ${status}.`}
      onClick={() => setOpen(true)}>
      <UsageIcon size={14} />
    </button>
    {open && <Modal title={`${label} usage`} onClose={() => setOpen(false)}>
      <p>Totals include nested features and subcategories, with retained usage from deleted sessions.</p>
      <dl className="usage-summary-details">
        <dt>Status</dt><dd>{status}</dd>
        <dt>AI credits</dt><dd>{credits}</dd>
        <dt>Input tokens</dt><dd>{formatTokens(totals.inputTokens)}</dd>
        <dt>Output tokens</dt><dd>{formatTokens(totals.outputTokens)}</dd>
        <dt>Reasoning output tokens</dt><dd>{formatTokens(totals.reasoningOutputTokens)}</dd>
        <dt>Sessions</dt><dd>{totals.sessions.toLocaleString()}</dd>
        <dt>Sessions awaiting usage</dt><dd>{node.sessionsWithoutUsage.toLocaleString()}</dd>
        <dt>Events with unavailable charges</dt><dd>{totals.unavailableCharges ?? 0}</dd>
        <dt>Reported USD estimate</dt><dd>{formatCost(totals.usdEstimate ?? null)}</dd>
      </dl>
      <Button variant="secondary" onClick={() => { setOpen(false); onOpenEvents(); }}>
        Open this feature's own usage events
      </Button>
    </Modal>}
  </>;
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
  const [filesOpen, setFilesOpen] = usePersistentState(
    `explorer.session.${session.id}.files`,
    false,
  );
  const [managingSkills, setManagingSkills] = useState(false);
  const [viewingUsage, setViewingUsage] = useState(false);
  const [skillSignal, setSkillSignal] = useState(0);

  const dot = sessionDotClass(session.status);

  // The persisted name is authoritative; fall back to any legacy localStorage
  // name (pre-persistence installs), then a title derived from the session's
  // launch prompt or CLI work history, and finally the ordinal label. Deriving
  // from the work title keeps sessions meaningfully named even when the custom
  // name is unavailable (e.g. localStorage cleared by an app data-path change).
  const name = sessionWorkTitle(
    session.name ?? customName,
    session.prompt,
    session.workTitle,
    ordinal,
    64,
    session.kind,
  );
  const model = session.resolvedModel ?? session.requestedModel;
  // Industry-standard per-session CLI indicator: a compact monogram badge
  // (e.g. Copilot → "C", Agency → "A") so the provider is scannable at a
  // glance, with the full name surfaced via the tooltip/title.
  const providerName = providerLabel(session.provider);
  const providerMonogram = providerName.charAt(0).toUpperCase();
  const liveTotals = sessionLiveTotals(live, session.id);
  // The persisted rollup is the authoritative source of truth: every usage
  // event is persisted and emitted together on the backend, so the rollup is
  // complete across reloads, whereas the live SSE feed only carries events
  // observed since the UI connected. We therefore prefer persisted totals —
  // the same basis the status bar uses — so the per-session AIC always matches
  // the workspace footer. Live totals are only a fallback for brand-new
  // sessions whose first events have not yet been folded into the rollup.
  const totals = resolveSessionMetrics(persisted, liveTotals);
  const details = `${name}\nStatus: ${session.status}\nProvider: ${session.provider} · Model: ${model}\n${
    totals ? `${formatAic(totals.nanoAiu)} credits` : 'Usage pending'
  } · Active: ${formatDuration(persisted?.activeMs ?? 0)}`;

  function startEditing() {
    setDraft(sessionWorkTitle(session.name ?? customName, session.prompt, session.workTitle, ordinal, 120, session.kind));
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
          maxLength={120}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              commit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div data-explorer-item={`session:${session.id}`} className={`session-card ${active ? 'is-active' : ''}`.trim()}>
      <div className="session-card-head">
        <button
          type="button"
          className="tree-toggle"
          aria-label={`${filesOpen ? 'Collapse' : 'Expand'} files for ${name}`}
          title={`${filesOpen ? 'Collapse' : 'Expand'} changed files`}
          aria-expanded={filesOpen}
          onClick={() => setFilesOpen((v) => !v)}
        >
          <ChevronIcon open={filesOpen} size={14} />
        </button>
        <button
          type="button"
          className="session-open"
          aria-current={active ? 'true' : undefined}
          title={details}
          onClick={onOpen}
          onDoubleClick={startEditing}
        >
          <span className="session-tree-icon" aria-hidden="true">
            <SessionIcon />
            <span className={`dot ${dot}`} />
            <span
              className="session-provider-badge"
              data-provider={session.provider}
              title={`${providerName} CLI`}
            >
              {providerMonogram}
            </span>
          </span>
          <span className="session-name">{name}</span>
        </button>
        <button
          type="button"
          className="tree-action session-usage-action"
          title={details}
          aria-label={`Usage breakdown for ${name}`}
          onClick={() => setViewingUsage(true)}
        >
          <UsageIcon size={14} />
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

      {viewingUsage && (
        <UsageBreakdownModal
          scope={{ kind: 'session', id: session.id, label: name }}
          onClose={() => setViewingUsage(false)}
        />
      )}

      {filesOpen && (
        <div className="session-files">
          <SkillChips scope="session" targetId={session.id} reloadSignal={skillSignal} />
          <SessionFiles
            sessionId={session.id}
            reloadSignal={live.fileChangesBySession[session.id] ?? 0}
          />
        </div>
      )}
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
    <div className="attached-agents" role="group" aria-label={`Agents for ${feature.name}`}>
      {attached.map((entry) => (
        <div
          key={entry.attachment.id}
          data-explorer-item={entry.manifest.id === 'review-board' ? `review-board:${feature.id}` : `agent:${entry.attachment.id}`}
          className="session-card pr-review-child attached-agent-row"
        >
          <div className="session-card-head">
            <button
              type="button"
              className="session-open"
              onClick={() => onOpenAgent(feature, entry)}
              title={`Agent: ${entry.manifest.title} for ${feature.name}`}
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
      await withOperationKey(`agent.attach:${feature.id}`, { agentId }, 'attachment', (operation) =>
        api.attachAgent(feature.id, agentId, operation),
      );
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
  const nodeAutomation = useAutomationReadiness();
  const usageContext = useContext(UsageSummaryContext);
  const summary = usageContext?.snapshot?.features[feature.id];
  const [expanded, setExpanded] = usePersistentState(
    `explorer.feature.${feature.id}.expanded`,
    false,
  );
  const reveal = useContext(ExplorerRevealContext);
  useEffect(() => {
    if (reveal?.featureIds.includes(feature.id)) setExpanded(true);
  }, [reveal, feature.id, setExpanded]);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteWorktrees, setDeleteWorktrees] = useState<
    FeatureDeletionWorktree[] | null
  >(null);
  const [viewingUsage, setViewingUsage] = useState(false);
  const [addingAgent, setAddingAgent] = useState(false);
  const [agentRefresh, setAgentRefresh] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nodeDropTarget, setNodeDropTarget] = useState(false);
  const [featureDropTarget, setFeatureDropTarget] = useState(false);
  const [prPickerParent, setPrPickerParent] = useState<string | null | false>(
    false,
  );
  /** A PR-review feature (its own checkout worktree) must not offer to open another PR inside itself. */
  const isPrFeature = Boolean(feature.checkoutPath);
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
    [feature.id, expanded, treeRevision, featureUsageRevision(live, feature.id)],
  );

  // When the delete confirmation opens, load the exact on-disk worktrees (and
  // the local branch each holds) the deletion would remove, so the dialog can
  // name them and the user consents before anything is destroyed.
  useEffect(() => {
    if (!confirming) {
      setDeleteWorktrees(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const preview = await api.previewFeatureDeletion(feature.id);
        if (!cancelled) {
          setDeleteWorktrees(preview.worktrees);
        }
      } catch {
        // A failed preview must not block deletion; fall back to no list.
        if (!cancelled) {
          setDeleteWorktrees([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [confirming, api, feature.id]);

  const rows = (sessions.data ?? []).map((s) => mergeLive(s, live));
  // Stable per-session ordinals: prefer the session's immutable creation
  // sequence so the "Session #N" fallback label never changes when the session
  // is moved between features or reordered. Legacy sessions without a sequence
  // fall back to their fetch-order position.
  const ordinals = new Map(rows.map((s, index) => [s.id, s.seq ?? index + 1]));
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
      usageContext?.invalidate();
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
        data-explorer-item={`feature:${feature.id}`}
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
        <span className="feature-tree-icon" aria-hidden="true">
          {isPrFeature ? <PullRequestIcon /> : <FolderIcon />}
        </span>
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
        <UsageBadge node={summary} label={feature.name} onOpenEvents={() => setViewingUsage(true)} />
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
              ...(onStartReview && !isPrFeature
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
            ].filter((item) => item.label !== 'Add agent' || nodeAutomation?.canAttempt !== false)}
          />
        </div>
        {confirming ? (
          <ConfirmDialog
            title="Delete feature"
            icon={<WarningIcon />}
            confirmLabel="Delete feature"
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
                {deleteWorktrees && deleteWorktrees.length > 0 ? (
                  <div className="confirm-dialog-worktrees">
                    <p className="confirm-dialog-note">
                      These local worktree checkouts will also be removed from
                      disk:
                    </p>
                    <ul className="confirm-dialog-worktree-list">
                      {deleteWorktrees.map((wt) => (
                        <li key={wt.path}>
                          <code>{wt.branch ?? 'detached'}</code>
                          <span className="confirm-dialog-worktree-path">
                            {wt.path}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            }
            onCancel={() => {
              setConfirming(false);
              setDeleteError(null);
            }}
            onConfirm={() => {
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
                  sessionWorkTitle(
                    session.name ?? names[session.id],
                    session.prompt,
                    session.workTitle,
                    ordinals.get(session.id) ?? session.seq ?? rows.length + 1,
                    64,
                    session.kind,
                  ),
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
            renderGroupUsage={(group) => <UsageBadge node={summary?.groups[group.id]}
              label={group.name} onOpenEvents={() => setViewingUsage(true)} />}
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
                    sessionWorkTitle(
                      session.name ?? names[session.id],
                      session.prompt,
                      session.workTitle,
                      ordinal,
                      64,
                      session.kind,
                    ),
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
  const reveal = useContext(ExplorerRevealContext);
  useEffect(() => {
    if (reveal && reveal.repoId === repoId) setExpanded(true);
  }, [reveal, repoId, setExpanded]);
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
      key={feature.id}
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
        data-explorer-item={`repo:${repoId ?? 'none'}`}
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
  activeTab = null,
  names,
  onOpenSession,
  onOpenFeature,
  onOpenPrReview,
  onOpenBulkPrReview,
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
  activeTab?: WorkspaceTab | null;
  names: Record<string, string>;
  onOpenSession: (session: Session, label: string) => void;
  onOpenFeature: (feature: Feature) => void;
  onOpenPrReview: (feature: Feature) => void;
  onOpenBulkPrReview: (
    parent: Feature,
    items: { feature: Feature; number: number; title: string }[],
  ) => void;
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
  const automation = useAutomationReadiness();
  const features = useAsync(() => api.listFeatures(), []);
  const loadingTree = (repos.loading && !repos.data) || (features.loading && !features.data);
  useEffect(() => featureDeletionStore.subscribe(features.reload), [features.reload]);
  const explorerRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const locateNonce = useRef(0);
  const [reveal, setReveal] = useState<React.ContextType<typeof ExplorerRevealContext>>(null);
  const [locating, setLocating] = useState(false);
  const [locateNotice, setLocateNotice] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  useEffect(() => {
    setReveal(null); setLocateNotice(null); setLocating(false);
    return () => { locateNonce.current += 1; };
  }, [activeTab?.id]);
  useEffect(() => {
    if (!reveal || !explorerRef.current) return;
    const root = explorerRef.current;
    let located: HTMLElement | undefined;
    const finish = () => {
      located = [...root.querySelectorAll<HTMLElement>('[data-explorer-item]')]
        .find((element) => element.dataset.explorerItem === reveal.target);
      if (!located) return;
      located.classList.add('is-located');
      located.tabIndex = -1;
      located.scrollIntoView({ block: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      located.focus({ preventScroll: true });
      setLocateNotice({ message: 'Active tab located in Explorer.', type: 'success' });
      setLocating(false);
      observer.disconnect();
      window.clearTimeout(timeout);
    };
    const observer = new MutationObserver(finish);
    const timeout = window.setTimeout(() => {
      observer.disconnect(); setLocating(false);
      setLocateNotice({ message: 'The active item is not available in Explorer. It may have been removed or its details could not load.', type: 'error' });
    }, 5000);
    observer.observe(root, { childList: true, subtree: true });
    finish();
    return () => { observer.disconnect(); window.clearTimeout(timeout); located?.classList.remove('is-located'); };
  }, [reveal]);
  const locateActive = async () => {
    const tab = activeTabRef.current;
    if (!tab) return;
    const nonce = ++locateNonce.current;
    setLocating(true); setLocateNotice(null); setReveal(null);
    try {
      if (tab.kind === 'repo') {
        setReveal({ nonce, repoId: tab.repo.id, featureIds: [], groupIds: [], target: `repo:${tab.repo.id}` });
        return;
      }
      const featureId = tab.kind === 'session' ? tab.session.featureId : tab.feature.id;
      const current = await api.listFeatures();
      const lineage: Feature[] = [];
      let feature = current.find((entry) => entry.id === featureId);
      if (!feature) throw new Error('The active feature is no longer available in Explorer.');
      while (feature && !lineage.some((entry) => entry.id === feature!.id)) {
        lineage.push(feature);
        feature = current.find((entry) => entry.id === feature!.parentFeatureId);
      }
      const needsFolderOwner = lineage.some((entry) => entry.parentGroupId && !entry.parentFeatureId);
      const groups = (await Promise.all((needsFolderOwner ? current : lineage).map((entry) => api.listGroups(entry.id)))).flat();
      for (let index = 0; index < lineage.length; index++) {
        const entry = lineage[index];
        const parentId = groups.find((group) => group.id === entry.parentGroupId)?.featureId ?? entry.parentFeatureId;
        const parent = current.find((candidate) => candidate.id === parentId);
        if (parent && !lineage.some((candidate) => candidate.id === parent.id)) lineage.push(parent);
      }
      const groupIds = new Set<string>();
      const addGroup = (id: string | null | undefined) => {
        while (id && !groupIds.has(id)) { groupIds.add(id); id = groups.find((group) => group.id === id)?.parentGroupId; }
      };
      lineage.forEach((entry) => addGroup(entry.parentGroupId));
      if (tab.kind === 'session') {
        const session = (await api.listSessions(featureId)).find((entry) => entry.id === tab.session.id);
        if (!session) throw new Error('The active session is no longer available in Explorer.');
        addGroup(session.groupId);
      }
      if (nonce !== locateNonce.current || activeTabRef.current?.id !== tab.id) return;
      setReveal({ nonce, repoId: lineage[0].repoId, featureIds: lineage.map((entry) => entry.id), groupIds: [...groupIds],
        target: tab.kind === 'session' ? `session:${tab.session.id}`
          : tab.kind === 'review-board' || tab.kind === 'agent' && tab.agentId === 'review-board' ? `review-board:${featureId}`
            : tab.kind === 'agent' ? `agent:${tab.attachmentId}` : `feature:${featureId}` });
    } catch (error) {
      if (nonce === locateNonce.current) setLocateNotice({ message: error instanceof Error ? error.message : 'Could not locate the active item.', type: 'error' });
    } finally { if (nonce === locateNonce.current) setLocating(false); }
  };
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
  usePrImportEvents(({ job }) => {
    features.reload();
    if (!job.feature) {
      setMoveError('The pull request import completed without a feature. Check its import status.');
      return;
    }
    if (!job.alreadyImported && job.importOptions?.autoReview !== false) {
      if (automation?.canAttempt === false) {
        setMoveError(automation.reason ?? 'The selected CLI cannot start automated reviews. Choose another CLI.');
      } else {
        reviewBoardRunStore.enqueueBulk([job.feature.id], api);
      }
    }
  });
  const [movingFeature, setMovingFeature] = useState<Feature | null>(null);
  const [treeRevision, setTreeRevision] = useState(0);
  const usageSummary = useUsageSummary(
    `${treeRevision}:${workspaceUsageRevision(live)}:${JSON.stringify(
      features.data?.map(({ id, parentFeatureId, parentGroupId }) => [id, parentFeatureId, parentGroupId]),
    )}`,
  );
  // A cross-feature session move that would switch the session's git branch is
  // held here until the user consents, since it relaunches the running CLI in
  // the new checkout (see confirmPendingMove).
  const [pendingMove, setPendingMove] = useState<{
    input: MoveNodeInput;
    fromBranch: string | null;
    toBranch: string | null;
    worktrees?: { id: string; checkoutPath: string; ref: string }[];
    taskCheckoutId?: string;
  } | null>(null);
  const [moveConsentBusy, setMoveConsentBusy] = useState(false);
  const [moveConsentError, setMoveConsentError] = useState<string | null>(null);

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
   * every expanded feature so both the source and target reflect the change.
   * A session move that crosses into a feature on a different git branch is
   * routed through a consent dialog first, since it relaunches the running CLI
   * in the destination checkout. */
  async function moveNode(input: MoveNodeInput) {
    if (input.type === 'session') {
      const session = await api.getSession(input.id);
      if (session.featureId !== input.targetFeatureId) {
        const [from, to] = await Promise.all([
          api.getFeatureEnvironment(session.featureId),
          api.getFeatureEnvironment(input.targetFeatureId),
        ]);
        if (to.worktrees?.length || session.worktreePath || (from.branch ?? null) !== (to.branch ?? null)) {
          setMoveConsentError(null);
          setPendingMove({ input, fromBranch: session.branch ?? from.branch, toBranch: to.branch, worktrees: to.worktrees });
          return;
        }
      }
    }
    await api.moveNode(input);
    setTreeRevision((v) => v + 1);
  }

  /** Applies a branch-changing session move the user consented to, then
   * relaunches its terminal so the CLI comes up on the destination branch. */
  async function confirmPendingMove() {
    if (!pendingMove) {
      return;
    }
    if (pendingMove.worktrees?.length && !pendingMove.taskCheckoutId) {
      setMoveConsentError('Choose a destination task worktree.');
      return;
    }
    setMoveConsentBusy(true);
    setMoveConsentError(null);
    try {
      await api.moveNode(pendingMove.input);
      await api.relaunchSession(pendingMove.input.id, pendingMove.taskCheckoutId);
      setTreeRevision((v) => v + 1);
      setPendingMove(null);
    } catch (error) {
      setMoveConsentError(
        error instanceof Error ? error.message : 'Could not move the session.',
      );
    } finally {
      setMoveConsentBusy(false);
    }
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
      const input = { name: name.trim(), description, repoId: targetRepoId };
      await withOperationKey(`feature.create:${targetRepoId ?? ''}`, input, 'feature', (operation) =>
        api.createFeature(input, operation),
      );
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
    const input = { name: featureName, description: '', repoId, parentGroupId };
    await withOperationKey(`feature.create-in-group:${parentGroupId}`, input, 'feature', (operation) =>
      api.createFeature(input, operation),
    );
    features.reload();
  }

  async function renameFeature(feature: Feature, next: string) {
    await onRenameFeature(feature, next);
    features.reload();
  }

  async function deleteFeature(feature: Feature) {
    if (!featureDeletionStore.enqueue(feature, () => onDeleteFeature(feature))) {
      throw new Error('The deletion queue is full. Wait for a deletion to finish, then try again.');
    }
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

  // A "Bulk PR Review" parent owns a set of PR features but has no worktree or
  // sessions of its own, so the generic feature dashboard is empty and useless
  // for it. Opening such a parent should instead surface the live review
  // tracker. Detect it by having children that are all PR features and
  // reconstruct the tracked PRs from their names (`PR #<n>: <title>`).
  function handleOpenFeature(feature: Feature) {
    if (!feature.checkoutPath) {
      const children = allFeatures.filter(
        (f) => (f.parentFeatureId ?? null) === feature.id,
      );
      if (children.length > 0) {
        const items: { feature: Feature; number: number; title: string }[] = [];
        let allPr = true;
        for (const child of children) {
          const match = /^PR #(\d+): (.*)$/s.exec(child.name);
          if (!match) {
            allPr = false;
            break;
          }
          items.push({
            feature: child,
            number: Number(match[1]),
            title: match[2],
          });
        }
        if (allPr && items.length > 0) {
          onOpenBulkPrReview(feature, items);
          return;
        }
      }
    }
    onOpenFeature(feature);
  }

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
    <UsageSummaryContext.Provider value={{
      snapshot: usageSummary.data,
      invalidate: () => {
        features.reload();
        setTreeRevision((revision) => revision + 1);
      },
    }}>
    <ExplorerRevealContext.Provider value={reveal}>
    <div className="explorer" ref={explorerRef}>
      <div className="explorer-header">
        <span className="explorer-title">Explorer</span>
        <div className="explorer-header-actions">
          <button type="button" className="tree-action" title="Locate active tab in Explorer"
            aria-label="Locate active tab in Explorer" disabled={!activeTab || locating} onClick={() => void locateActive()}>
            <LocateIcon />
          </button>
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
      {locateNotice && <p className={locateNotice.type === 'success' ? 'sr-only' : 'explorer-locate-notice'}
        role="status">{locateNotice.message}</p>}

      {addingRepo && (
        <RepoPicker
          onClose={() => setAddingRepo(false)}
          onAdded={() => {
            setAddingRepo(false);
            repos.reload();
          }}
        />
      )}

      {pendingMove && (
        <ConfirmDialog
          title="Switch branch?"
          icon={<WarningIcon />}
          confirmLabel="Move and switch branch"
          busy={moveConsentBusy}
          error={moveConsentError}
          message={
            <>
              {pendingMove.worktrees && <label>
                Destination task worktree
                <select value={pendingMove.taskCheckoutId ?? ''} onChange={(event) => {
                  const choice = pendingMove.worktrees?.find((item) => item.id === event.target.value);
                  setPendingMove({ ...pendingMove, taskCheckoutId: choice?.id, toBranch: choice?.ref ?? null });
                  setMoveConsentError(null);
                }}>
                  <option value="">Choose a checkout</option>
                  {pendingMove.worktrees.map((choice) => <option key={choice.id} value={choice.id}>{choice.ref} - {choice.checkoutPath}</option>)}
                </select>
              </label>}
              <p className="confirm-dialog-lead">
                This session runs on{' '}
                <strong>{pendingMove.fromBranch ?? 'its current branch'}</strong>.
              </p>
              <p className="confirm-dialog-note">
                Moving it here switches it to{' '}
                <strong>{pendingMove.toBranch ?? 'the destination branch'}</strong>.
                Its terminal relaunches in the new checkout, ending the current
                run.
              </p>
            </>
          }
          onCancel={() => {
            setPendingMove(null);
            setMoveConsentError(null);
          }}
          onConfirm={() => void confirmPendingMove()}
        />
      )}

      {reviewRepo && (
        <PrReviewPicker
          repo={reviewRepo.repo}
          onClose={() => setReviewRepo(null)}
          onConfirm={(pulls) => {
            if (automation?.canAttempt === false && pulls.some((pull) => pull.importOptions?.autoReview !== false)) {
              setMoveError(automation.reason ?? 'Choose another CLI before starting automated reviews.');
              return;
            }
            const result = prImportStore.enqueue(api, {
              repo: { id: reviewRepo.repo.id, name: reviewRepo.repo.name },
              pulls,
              parentFeatureId: reviewRepo.parentFeatureId ?? null,
              batchName: bulkReviewName(),
            });
            const queueFull = result.skipped.filter((item) => item.reason === 'queue-full');
            if (queueFull.length > 0) {
              throw new Error(`The import queue is full. PRs ${queueFull.map((item) => `#${item.number}`).join(', ')} were not queued. Your selection is kept; wait for an import to finish and try again.`);
            }
            if (result.skipped.length > 0) {
              setMoveError(`PRs ${result.skipped.map((item) => `#${item.number}`).join(', ')} are already imported or have an import in progress. Use PR import status to open or check them.`);
            }
            setReviewRepo(null);
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
        {!usageSummary.data && usageSummary.loading && <div className="explorer-usage-error" role="status">
          Loading usage...
        </div>}
        {usageSummary.error && <div className="explorer-usage-error" role="status">
          <span>{usageSummary.data ? 'Usage is stale. ' : ''}{usageSummary.error}</span>
          <Button variant="secondary" disabled={usageSummary.loading} onClick={usageSummary.retry}>Retry usage</Button>
        </div>}
        {loadingTree && <BrandedLoader title="Loading Explorer" detail="Organizing repositories and features" />}
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
        {!loadingTree && <NodeDragStoreProvider>
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
            onOpenFeature={handleOpenFeature}
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
            onOpenFeature={handleOpenFeature}
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
        </NodeDragStoreProvider>}
      </div>
      <div className="explorer-status-footer">
      <PrImportStatus
        api={api}
        onOpen={(job) => {
          if (job.feature) onOpenPrReview(job.feature);
          else setMoveError('This pull request does not have an imported feature yet.');
        }}
        onOpenBatch={(batch, jobs) => {
          if (!batch.parent) {
            setMoveError('This pull request batch does not have a parent feature yet.');
            return;
          }
          onOpenBulkPrReview(batch.parent, jobs.flatMap((job) => job.feature
            ? [{ feature: job.feature, number: job.number, title: job.title }]
            : []));
        }}
      />
      <details className="explorer-footer">
        <summary>Accounts</summary>
        <div className="explorer-accounts">
          <GithubStatusBadge />
          <AzureStatusBadge />
        </div>
      </details>
      </div>
    </div>
    </ExplorerRevealContext.Provider>
    </UsageSummaryContext.Provider>
  );
}
