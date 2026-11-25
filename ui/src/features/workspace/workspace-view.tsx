import { lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import type { LiveState } from '../../lib/stream.js';
import type { Feature, Repository, Session, AttachedAgent, PrReview } from '../../lib/types.js';
import type { WorkspaceLaunchIntent } from '../../lib/planner-launch.js';
import { compatibleSession } from '../../lib/provider-selection.js';
import { withOperationKey } from '../../lib/operation-keys.js';
import { createSessionNameStore } from '../../lib/session-names.js';
import { featureColor } from '../../lib/feature-color.js';
import { PaneResizer } from '../../components/pane-resizer.js';
import { formatDateTime } from '../../lib/format.js';
import { ApiProvider, useApi } from '../../app/api-context.js';
import { useStartupPending } from '../../app/desktop-lifecycle.js';
import { usePersistentState } from '../../hooks/use-persistent-state.js';
import { clampNumber, isFiniteNumber } from '../../lib/persisted-state.js';
import { EmptyState, Modal } from '../../components/ui.js';
import { AiMagicIcon, ChevronIcon, CloseIcon, CollapseSidebarIcon, CollapseRightPanelIcon, ExpandIcon, MoreIcon, PopOutIcon, PullRequestIcon, RestoreIcon, SplitViewIcon } from '../../components/icons.js';
import { Tooltip } from '../../components/tooltip.js';
import { useAnimatedPresence } from '../../hooks/use-motion.js';
import { SessionHistoryPane } from './session-history-pane.js';
import { desktopBridge } from '../../lib/desktop-bridge.js';
import { isPoppableTab, type PoppableTab } from './tab-popout.js';
import { ErrorBoundary } from '../../components/error-boundary.js';
import { ViewSkeleton } from '../../components/view-skeleton.js';
import { Explorer } from './explorer.js';
import { getAgentModule } from '../../agent-host/agent-registry.js';
import { reviewBoardRunStore } from '../review-board-page/review-board-run-store.js';
import { featureDeletionStore } from '../../lib/feature-deletion-store.js';
import { AutomationBoundary } from '../../app/automation-readiness.js';
import {
  closeWorkspaceTab,
  closeAllWorkspaceTabs,
  closeWorkspaceTabsToLeft,
  closeWorkspaceTabsToRight,
  emptyWorkspaceTabsState,
  featureSubtreeIds,
  groupWorkspaceTabs,
  isWorkspaceTabsState,
  openWorkspaceTab,
  reconcileWorkspaceTabsState,
  removeFeatureWorkspaceTabs,
  removeSessionWorkspaceTabs,
  removeRepoWorkspaceTabs,
  removeAgentWorkspaceTabs,
  setWorkspaceSplit,
  type WorkspaceTab,
  type WorkspaceTabsState,
} from './workspace-tabs.js';

// Heavy, view-specific bundles (xterm for terminals, recharts for the feature
// and repo dashboards, the change-graph stack for PR review) are code-split so
// opening the workspace doesn't eagerly download them. Each only loads the
// first time its tab is activated. Named exports are mapped to the default
// shape React.lazy expects.
const TerminalView = lazy(() =>
  import('../../components/terminal-view.js').then((m) => ({
    default: m.TerminalView,
  })),
);
const FeatureDashboard = lazy(() =>
  import('../feature-dashboard/feature-dashboard.js').then((m) => ({
    default: m.FeatureDashboard,
  })),
);
const RepoDashboard = lazy(() =>
  import('../repo-dashboard/repo-dashboard.js').then((m) => ({
    default: m.RepoDashboard,
  })),
);
const BulkReviewTracker = lazy(() =>
  import('./bulk-review-tracker.js').then((m) => ({
    default: m.BulkReviewTracker,
  })),
);

function featureTabId(featureId: string): string {
  return `feature:${featureId}`;
}

function repoTabId(repoId: string): string {
  return `repo:${repoId}`;
}

/** The feature id a tab belongs to, for color-coding session and feature tabs. */
function tabFeatureId(tab: WorkspaceTab): string {
  return tab.kind === 'session'
    ? tab.session.featureId
    : tab.kind === 'repo'
      ? tab.repo.id
      : tab.feature.id;
}

/**
 * IDE-style workspace: a collapsible Explorer (Features -> Sessions) on the
 * left and a tabbed editor. Session tabs host the live CLI terminal; feature
 * tabs host the graphical usage dashboard — so both open like files.
 */
export function WorkspaceView({
  live,
  sidebarOpen,
  onToggleSidebar,
  reopen = null,
  launch = null,
  onLaunchConsumed,
  providerSwitch = null,
  onMonitoringOrigin,
}: {
  live: LiveState;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  reopen?: { tab: PoppableTab; label: string; nonce: number } | null;
  launch?: { intent: WorkspaceLaunchIntent; nonce: number } | null;
  onLaunchConsumed?: () => void;
  providerSwitch?: { providerId: string; nonce: number } | null;
  onMonitoringOrigin?: (restore: () => void, key: string) => void;
}) {
  const nameStore = useMemo(
    () => createSessionNameStore(window.localStorage),
    [],
  );
  const api = useApi();
  const [names, setNames] = useState<Record<string, string>>(() =>
    nameStore.all(),
  );
  const [tabState, setTabState] = usePersistentState(
    'cw-workspace-tabs',
    emptyWorkspaceTabsState(),
    { validate: isWorkspaceTabsState },
  );
  const [explorerWidth, setExplorerWidth] = usePersistentState(
    'cw-explorer-width',
    260,
    {
      validate: isFiniteNumber,
      normalize: (w) => clampNumber(w, 200, 560),
    },
  );

  const tabs = tabState.tabs;
  useEffect(() => {
    onMonitoringOrigin?.(() => setTabState((state) => setWorkspaceSplit({
      ...state, activeId: state.tabs.some((tab) => tab.id === tabState.activeId) ? tabState.activeId : state.activeId,
    }, tabState.splitId)), JSON.stringify([tabState.activeId, tabState.splitId]));
  }, [onMonitoringOrigin, tabState.activeId, tabState.splitId, setTabState]);
  const [restoring, setRestoring] = useState(true);
  useStartupPending(restoring);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const fullscreenLayout = useRef<{ activeId: string | null; splitId: string | null } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenLeftOpen, setFullscreenLeftOpen] = useState(false);
  const [fullscreenRightOpen, setFullscreenRightOpen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const [sessionDetailsId, setSessionDetailsId] = useState<string | null>(null);
  const [terminalDiagnosticsId, setTerminalDiagnosticsId] = useState<string | null>(null);
  const detailsTab = tabs.find((tab) => tab.id === sessionDetailsId);
  const explorerOpen = fullscreen ? fullscreenLeftOpen : sidebarOpen;
  const toggleExplorer = () => fullscreen ? setFullscreenLeftOpen((value) => !value) : onToggleSidebar();
  useEffect(() => {
    const changed = () => {
      const active = document.fullscreenElement === workspaceRef.current;
      setFullscreen(active);
      if (!active && fullscreenLayout.current) {
        const layout = fullscreenLayout.current;
        fullscreenLayout.current = null;
        setTabState((state) => {
          const activeId = state.tabs.some((tab) => tab.id === layout.activeId) ? layout.activeId : state.activeId;
          const splitId = layout.splitId !== activeId && state.tabs.some((tab) => tab.id === layout.splitId) ? layout.splitId : null;
          return { ...state, activeId, splitId };
        });
      }
    };
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, [setTabState]);
  const toggleFullscreen = async (tabId?: string) => {
    setFullscreenError(null);
    setTabMenu(null);
    try {
      if (document.fullscreenElement === workspaceRef.current) {
        await document.exitFullscreen();
      } else {
        fullscreenLayout.current = { activeId: tabState.activeId, splitId: tabState.splitId ?? null };
        setFullscreenLeftOpen(false);
        setFullscreenRightOpen(false);
        if (!workspaceRef.current?.requestFullscreen) throw new Error('Fullscreen is unavailable in this window.');
        await workspaceRef.current.requestFullscreen();
        if (tabId) setTabState((state) => setWorkspaceSplit({ ...state, activeId: tabId }, state.splitId));
      }
    } catch (cause) {
      if (document.fullscreenElement !== workspaceRef.current) fullscreenLayout.current = null;
      setFullscreenError(cause instanceof Error ? cause.message : 'Fullscreen could not be changed. Retry from Tab actions.');
    }
  };
  const [openTabGroups, setOpenTabGroups] = useState<Record<string, boolean>>({});
  const tabGroups = groupWorkspaceTabs(tabs);
  const orderedTabs = tabGroups.flatMap((group) => group.tabs);
  const [bootstrapProvider, setBootstrapProvider] = useState<string | null | undefined>(undefined);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const activeProvider = providerSwitch?.providerId ?? bootstrapProvider;
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => api.getProviderBootstrap()).then((info) => {
      if (active) setBootstrapProvider(info.selectionRequired ? null : info.defaultProvider);
    }).catch(() => {});
    return () => { active = false; };
  }, [api]);
  const switchWork = useRef<{ nonce: number; work: Promise<Session | null> } | null>(null);
  const pendingSwitchSessions = useRef(new Map<string, Session>());
  useEffect(() => {
    if (!providerSwitch) return;
    let cancelled = false;
    setSwitchError(null);
    if (switchWork.current?.nonce !== providerSwitch.nonce) {
      const current = tabState.tabs.find((tab) => tab.id === tabState.activeId);
      const featureId = current && current.kind !== 'repo' ? tabFeatureId(current) : null;
      const work = !featureId ? Promise.resolve(null) : (async () => {
        const sessions = await api.listSessions(featureId);
        const existing = compatibleSession(sessions, providerSwitch.providerId);
        if (existing) return existing;
        const input = { providerId: providerSwitch.providerId, kind: 'dev' as const };
        return withOperationKey(`provider-switch:${featureId}`, input, 'session', (operation) =>
          api.createTerminalSession(featureId, input, operation),
        );
      })();
      switchWork.current = { nonce: providerSwitch.nonce, work };
    }
    void switchWork.current.work.then((session) => {
      if (cancelled || !session) return;
      pendingSwitchSessions.current.set(session.id, session);
      pendingTabFocus.current = session.id;
      setTabState((state) => openWorkspaceTab({ ...state, splitId: null }, {
        kind: 'session', id: session.id, label: session.name ?? 'Session', session,
      }));
    }).catch((failure: unknown) => {
      if (!cancelled) setSwitchError(`CLI changed, but the workspace session could not be opened: ${failure instanceof Error ? failure.message : String(failure)}`);
    });
    return () => { cancelled = true; };
  }, [api, providerSwitch, setTabState]);
  const [splitRatio, setSplitRatio] = usePersistentState('cw-workspace-split-ratio', 50, {
    validate: isFiniteNumber,
    normalize: (value) => clampNumber(value, 25, 75),
  });
  const editorBodyRef = useRef<HTMLDivElement>(null);
  const workspaceId = useId();
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingTabFocus = useRef<string | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const sidebarPresence = useAnimatedPresence(explorerOpen, '--motion-panel-duration');
  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    sidebar.toggleAttribute('inert', !explorerOpen);
    if (!explorerOpen && sidebar.contains(document.activeElement)) {
      const explorerToggle = document.querySelector<HTMLButtonElement>(fullscreen ? '[aria-label="Show explorer"]' : '.activitybar [aria-label="Explorer"]');
      (explorerToggle ?? editorBodyRef.current)?.focus({ preventScroll: true });
    }
  }, [explorerOpen, fullscreen]);
  useLayoutEffect(() => {
    if (pendingTabFocus.current === null) return;
    const target = tabButtons.current.get(pendingTabFocus.current) ?? editorBodyRef.current;
    target?.focus({ preventScroll: true });
    pendingTabFocus.current = null;
  }, [tabs, tabState.activeId]);
  const activeId = tabState.activeId;
  const [deletionRevision, setDeletionRevision] = useState(0);
  useEffect(() => featureDeletionStore.subscribe(() => setDeletionRevision((revision) => revision + 1)), []);
  const knownFeatures = useRef<Feature[]>([]);
  const pendingImportedFeatures = useRef(new Map<string, Feature>());
  const knownAttachments = useRef(new Map<string, AttachedAgent['attachment']>());
  const trackedReviewSignal = tabs.some((tab) => tab.kind === 'pr-review-tracker')
    ? JSON.stringify(Object.values(live.prReviews).map((review) => [
        review.featureId, review.pull.number, review.pull.title,
      ]))
    : '';

  // Explorer's nested rows own repo removal and agent detachment. Observe
  // successful mutations at their API boundary without changing other callers.
  const explorerApi = useMemo(() => ({
    ...api,
    async deleteRepo(id: string) {
      const result = await api.deleteRepo(id);
      setTabState((prev) => removeRepoWorkspaceTabs(prev, id));
      setDeletionRevision((revision) => revision + 1);
      return result;
    },
    async detachAgent(id: string) {
      const result = await api.detachAgent(id);
      const attachment = knownAttachments.current.get(id);
      setTabState((prev) => removeAgentWorkspaceTabs(prev, id, attachment));
      setDeletionRevision((revision) => revision + 1);
      return result;
    },
    async deleteGroup(id: string) {
      const result = await api.deleteGroup(id);
      setDeletionRevision((revision) => revision + 1);
      return result;
    },
  }), [api, setTabState]);

  useEffect(() => {
    const featureTabs = tabs.filter(
      (tab) =>
        tab.kind === 'feature' ||
        tab.kind === 'review-board' ||
        tab.kind === 'pr-review-tracker' ||
        tab.kind === 'agent',
    );
    const sessionFeatureIds = [
      ...new Set(
        tabs
          .filter((tab): tab is Extract<WorkspaceTab, { kind: 'session' }> =>
            tab.kind === 'session')
          .map((tab) => tab.session.featureId),
      ),
    ];
    const hasRepoTabs = tabs.some((tab) => tab.kind === 'repo');
    const agentFeatureIds = [...new Set(
      tabs.flatMap((tab) =>
        tab.kind === 'agent' || tab.kind === 'review-board' ? [tab.feature.id] : [],
      ),
    )];
    if (
      featureTabs.length === 0 &&
      sessionFeatureIds.length === 0 &&
      !hasRepoTabs
    ) {
      setRestoring(false);
      return;
    }

    let active = true;
    setRestoring(true);
    void (async () => {
      const [features, repos, sessionsByFeature, agentsByFeature] = await Promise.all([
        featureTabs.length > 0 || sessionFeatureIds.length > 0
          ? api
              .listFeatures()
              .then((loaded) => new Map(loaded.map((feature) => [feature.id, feature])))
              .catch(() => null)
          : Promise.resolve(null),
        hasRepoTabs
          ? api
              .listRepos()
              .then((loaded) => new Map(loaded.map((repo) => [repo.id, repo])))
              .catch(() => null)
          : Promise.resolve(null),
        sessionFeatureIds.length > 0
          ? Promise.all(
              sessionFeatureIds.map(async (featureId) => {
                try {
                  const loaded = await api.listSessions(featureId, {
                    includeInternal: true,
                  });
                  return [
                    featureId,
                    new Map(loaded.map((session) => [session.id, session])),
                  ] as const;
                } catch {
                  return [featureId, null] as const;
                }
              }),
            ).then((entries) => new Map(entries))
          : Promise.resolve(new Map<string, Map<string, Session> | null>()),
        Promise.all(agentFeatureIds.map(async (featureId) => {
          try {
            return [featureId, await api.listFeatureAgents(featureId)] as const;
          } catch {
            return [featureId, null] as const;
          }
        })).then((entries) => new Map(entries)),
      ]);
      if (!active) return;
      // Successful checkout responses are newer than an Explorer/list request
      // already in flight. Keep them until a feature listing confirms them.
      if (features) {
        for (const [id, feature] of pendingImportedFeatures.current) {
          if (features.has(id)) {
            pendingImportedFeatures.current.delete(id);
          } else {
            features.set(id, feature);
            agentsByFeature.set(id, null);
          }
        }
      }
      const trackerIds = new Set(tabs.flatMap((tab) =>
        tab.kind === 'pr-review-tracker' ? [tab.feature.id] : [],
      ));
      const prReviews = new Map<string, Pick<PrReview, 'pull'> | null>();
      await Promise.all([...(features?.values() ?? [])]
        .filter((feature) => feature.parentFeatureId && trackerIds.has(feature.parentFeatureId))
        .map(async (feature) => {
          try {
            const review = live.prReviews[feature.id] ?? await api.getPrReview(feature.id);
            prReviews.set(feature.id, review);
          } catch {
            // A regular child feature is not necessarily a PR. Keep existing
            // imported metadata on failure, but never invent a PR identity.
            prReviews.set(feature.id, null);
          }
        }));
      if (!active) {
        return;
      }
      if (features) knownFeatures.current = [...features.values()];
      for (const [id, session] of pendingSwitchSessions.current) {
        const loaded = sessionsByFeature.get(session.featureId);
        if (loaded?.has(id)) pendingSwitchSessions.current.delete(id);
        else loaded?.set(id, session);
      }
      for (const [featureId, agents] of agentsByFeature) {
        if (!agents) continue;
        for (const [id, attachment] of knownAttachments.current) {
          if (attachment.featureId === featureId) knownAttachments.current.delete(id);
        }
        for (const { attachment } of agents) {
          knownAttachments.current.set(attachment.id, attachment);
        }
      }
      setTabState((prev) =>
        reconcileWorkspaceTabsState(prev, { features, repos, sessionsByFeature, agentsByFeature, prReviews }),
      );
    })().finally(() => { if (active) setRestoring(false); });

    return () => {
      active = false;
    };
  }, [
    api,
    setTabState,
    deletionRevision,
    trackedReviewSignal,
    tabs
      .map((tab) =>
        tab.kind === 'session'
          ? `${tab.kind}:${tab.id}:${tab.session.featureId}`
          : `${tab.kind}:${tab.id}`,
      )
      .join('|'),
  ]);

  function openTab(tab: WorkspaceTab) {
    setTabState((prev) => openWorkspaceTab(prev, tab));
  }

  function openSession(session: Session, label: string) {
    openTab({ kind: 'session', id: session.id, label, session });
  }

  function openFeature(feature: Feature) {
    openTab({
      kind: 'feature',
      id: featureTabId(feature.id),
      label: feature.name,
      feature,
    });
  }

  function openReviewBoard(feature: Feature) {
    openTab({
      kind: 'agent',
      id: `agent:review-board:${feature.id}`,
      label: `Review Board · ${feature.name}`,
      agentId: 'review-board',
      attachmentId: `review-board:${feature.id}`,
      feature,
    });
  }

  /** Activate an already-open Review Board tab for a PR feature, if present. */
  function focusReviewBoard(featureId: string) {
    const id = `agent:review-board:${featureId}`;
    setTabState((prev) =>
      prev.tabs.some((tab) => tab.id === id)
        ? setWorkspaceSplit({ ...prev, activeId: id }, prev.splitId)
        : prev,
    );
  }

  /**
   * Opens a Review Board tab per selected PR, then a single "Bulk PR Review"
   * tracker tab (made active) that drives and shows each PR's live progress.
   */
  function openBulkPrReview(
    parent: Feature,
    items: { feature: Feature; number: number; title: string }[],
  ) {
    pendingImportedFeatures.current.set(parent.id, parent);
    for (const item of items) {
      pendingImportedFeatures.current.set(item.feature.id, item.feature);
      openReviewBoard(item.feature);
    }
    openTab({
      kind: 'pr-review-tracker',
      id: `pr-review-tracker:${parent.id}`,
      label: parent.name,
      feature: parent,
      prs: items.map((item) => ({
        featureId: item.feature.id,
        number: item.number,
        title: item.title,
      })),
    });
  }

  function openAgent(feature: Feature, attached: AttachedAgent) {
    const { manifest, attachment } = attached;
    const id = manifest.allowMultiplePerFeature
      ? `agent:${attachment.id}`
      : `agent:${manifest.id}:${feature.id}`;
    openTab({
      kind: 'agent',
      id,
      label: `${manifest.title} · ${feature.name}`,
      agentId: manifest.id,
      attachmentId: attachment.id,
      feature,
    });
  }

  function openRepo(repo: Repository) {
    openTab({
      kind: 'repo',
      id: repoTabId(repo.id),
      label: repo.name,
      repo,
    });
  }

  function renameSession(sessionId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    // Optimistic local update so the label changes instantly, then persist to
    // the backend as the source of truth (survives reloads and other devices).
    nameStore.set(sessionId, trimmed);
    setNames(nameStore.all());
    setTabState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.kind === 'session' && tab.session.id === sessionId
          ? { ...tab, label: trimmed || tab.label }
          : tab,
      ),
    }));
    return api
      .renameSession(sessionId, trimmed || null)
      .then((updated) => {
        setTabState((prev) => ({
          ...prev,
          tabs: prev.tabs.map((tab) =>
            tab.kind === 'session' && tab.session.id === sessionId
              ? { ...tab, session: updated, label: updated.name ?? tab.label }
              : tab,
          ),
        }));
      });
  }

  function closeTab(id: string) {
    const close = (state: WorkspaceTabsState) => closeWorkspaceTab({
      ...state, tabs: groupWorkspaceTabs(state.tabs).flatMap((group) => group.tabs),
    }, id);
    if (tabButtons.current.get(id)?.closest('.tab')?.contains(document.activeElement)) {
      pendingTabFocus.current = close(tabState).activeId ?? '';
    }
    setTabState(close);
  }

  // Right-click tab menu: bulk-close actions anchored at the cursor. `tabId` is
  // the tab that was right-clicked; the disabled state of each action depends on
  // its position in the strip.
  const [tabMenu, setTabMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = tabMenuRef.current;
    if (!tabMenu || !menu) return;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(tabMenu.x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(tabMenu.y, window.innerHeight - rect.height - 8))}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      if (menu.contains(document.activeElement)) tabButtons.current.get(tabMenu.tabId)?.focus();
    };
  }, [tabMenu]);
  function openTabMenu(event: ReactMouseEvent, tabId: string) {
    event.preventDefault();
    setTabMenu({ tabId, x: event.clientX, y: event.clientY });
  }
  useEffect(() => {
    if (!tabMenu) {
      return undefined;
    }
    const dismiss = () => setTabMenu(null);
    window.addEventListener('click', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (tabMenuRef.current?.contains(document.activeElement)) {
          tabButtons.current.get(tabMenu.tabId)?.focus({ preventScroll: true });
        }
        setTabMenu(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [tabMenu]);

  // Tear a session terminal or agent board out of the IDE into its own OS
  // window. The main-process pop-out handler owns the window; we drop the
  // in-IDE tab so it lives in one place. Closing/returning the window re-opens
  // the tab via the `tab:return` subscription wired through App.
  const canPopOut = Boolean(desktopBridge()?.windows?.popOut);
  function popOutTab(tab: PoppableTab, label: string) {
    void desktopBridge()?.windows?.popOut?.({ tab, label });
    closeTab(tab.id);
  }

  // Re-open a tab when its detached window is returned/closed. Keyed on the
  // nonce so returning the same tab twice still re-opens it.
  const reopenNonce = reopen?.nonce ?? null;
  useEffect(() => {
    if (!reopen) {
      return;
    }
    openTab(reopen.tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reopenNonce]);

  // Open a tab for a launch intent handed over from the Planner. Keyed on the
  // nonce so launching the same task twice still opens a fresh tab. Imported
  // features are registered as pending so a concurrent tree reload keeps them.
  const launchNonce = launch?.nonce ?? null;
  useEffect(() => {
    if (!launch) {
      return;
    }
    const { intent } = launch;
    if (intent.kind === 'session') {
      openSession(intent.session, intent.label);
    } else if (intent.kind === 'agent') {
      pendingImportedFeatures.current.set(intent.feature.id, intent.feature);
      openAgent(intent.feature, intent.attached);
    } else {
      pendingImportedFeatures.current.set(intent.feature.id, intent.feature);
      openReviewBoard(intent.feature);
    }
    onLaunchConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchNonce]);

  async function renameFeature(feature: Feature, name: string) {
    const updated = await api.renameFeature(feature.id, name);
    setTabState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.kind === 'feature' && tab.feature.id === updated.id
          ? { ...tab, label: updated.name, feature: updated }
          : tab,
      ),
    }));
  }

  async function deleteFeature(feature: Feature) {
    const features = [
      ...pendingImportedFeatures.current.values(),
      ...await api.listFeatures().catch(() => knownFeatures.current),
    ];
    await api.deleteFeature(feature.id);
    const deletedIds = featureSubtreeIds(feature.id, [
      ...tabs.flatMap((tab) => 'feature' in tab ? [tab.feature] : []),
      ...features,
    ]);
    for (const id of deletedIds) {
      pendingImportedFeatures.current.delete(id);
      reviewBoardRunStore.remove(id);
    }
    setTabState((prev) => removeFeatureWorkspaceTabs(prev, feature.id, features));
    setDeletionRevision((revision) => revision + 1);
  }

  async function deleteSession(session: Session) {
    await api.deleteSession(session.id);
    setTabState((prev) => removeSessionWorkspaceTabs(prev, session.id));
    setDeletionRevision((revision) => revision + 1);
  }

  const active = tabs.find((t) => t.id === activeId) ?? null;
  const activeSessionId = active?.kind === 'session' ? active.session.id : null;
  const splitId = fullscreen ? null : tabState.splitId ?? null;
  const splitTab = splitId ? tabs.find((t) => t.id === splitId) ?? null : null;

  function tabDisplayLabel(tab: WorkspaceTab): string {
    if (tab.kind === 'session') {
      return (
        tab.session.name?.trim() || names[tab.session.id]?.trim() || tab.label
      );
    }
    return tab.label;
  }

  function openToSide(id: string) {
    setTabState((prev) => setWorkspaceSplit(prev, id));
  }

  function closeSplit() {
    setTabState((prev) => setWorkspaceSplit(prev, null));
  }

  function renderTabBody(tab: WorkspaceTab) {
    if (tab.kind === 'session') {
      return (
        <div key={tab.session.id} className="session-editor">
          <Suspense fallback={<ViewSkeleton label="terminal" />}>
            {activeProvider !== undefined && tab.session.provider !== activeProvider
              ? <p>This session belongs to {tab.session.provider}. Its history is preserved. Choose that CLI to resume it.</p>
              : <TerminalView sessionId={tab.session.id}
                diagnosticsOpen={terminalDiagnosticsId === tab.session.id}
                onCloseDiagnostics={() => setTerminalDiagnosticsId(null)} />}
          </Suspense>
        </div>
      );
    }
    if (tab.kind === 'feature') {
      return (
        <Suspense fallback={<ViewSkeleton label="dashboard" />}>
          <FeatureDashboard
            key={tab.feature.id}
            featureId={tab.feature.id}
            featureName={tab.feature.name}
            featureDescription={tab.feature.description}
            contextPhase={live.contextStatus[`feature:${tab.feature.id}`]}
            live={live}
          />
        </Suspense>
      );
    }
    if (tab.kind === 'agent') {
      const agentModule = getAgentModule(tab.agentId);
      if (!agentModule) {
        return (
          <div className="editor-empty">
            <EmptyState
              icon={<AiMagicIcon size={28} />}
              title="Unknown agent"
              description={`No UI is registered for "${tab.agentId}".`}
            />
          </div>
        );
      }
      const AgentComponent = agentModule.component;
      return (
        <ErrorBoundary label={agentModule.title}>
          <AutomationBoundary>
          <Suspense fallback={<ViewSkeleton label={agentModule.title} />}>
            <AgentComponent
              key={tab.id}
              ctx={{
                feature: tab.feature,
                attachmentId: tab.attachmentId,
                agentId: tab.agentId,
                openSession,
              }}
            />
          </Suspense>
          </AutomationBoundary>
        </ErrorBoundary>
      );
    }
    if (tab.kind === 'repo') {
      return (
        <Suspense fallback={<ViewSkeleton label="repository" />}>
          <RepoDashboard key={tab.repo.id} repo={tab.repo} />
        </Suspense>
      );
    }
    if (tab.kind === 'pr-review-tracker') {
      return (
        <ErrorBoundary label="Bulk PR Review">
          <AutomationBoundary>
          <Suspense fallback={<ViewSkeleton label="bulk review" />}>
            <BulkReviewTracker
              key={tab.feature.id}
              title={tab.feature.name}
              prs={tab.prs}
              live={live}
              onOpen={focusReviewBoard}
            />
          </Suspense>
          </AutomationBoundary>
        </ErrorBoundary>
      );
    }
    return null;
  }

  return (
    <div
      ref={workspaceRef}
      className={`workspace${explorerOpen ? '' : ' is-collapsed'}${fullscreen ? ' is-fullscreen' : ''}`}
      style={
        explorerOpen
          ? ({ '--explorer-width': `${explorerWidth}px` } as CSSProperties)
          : undefined
      }
    >
      {switchError && <p role="alert">{switchError}</p>}
      {fullscreenError && <p role="alert" className="workspace-fullscreen-error">{fullscreenError}</p>}
      {detailsTab?.kind === 'session' && <Modal title="Session details" onClose={() => setSessionDetailsId(null)}>
        <dl className="clarity-details-grid">
          <dt>Session ID</dt><dd>{detailsTab.session.id}</dd>
          <dt>Provider</dt><dd>{detailsTab.session.provider}</dd>
          <dt>Recorded status</dt><dd>{detailsTab.session.status}</dd>
          <dt>Requested model</dt><dd>{detailsTab.session.requestedModel || 'Provider default'}</dd>
          <dt>Resolved model</dt><dd>{detailsTab.session.resolvedModel || 'Not reported'}</dd>
          <dt>Created</dt><dd>{formatDateTime(detailsTab.session.createdAt || null)}</dd>
          <dt>Started</dt><dd>{formatDateTime(detailsTab.session.startedAt)}</dd>
          <dt>Ended</dt><dd>{formatDateTime(detailsTab.session.endedAt)}</dd>
          <dt>Exit code</dt><dd>{detailsTab.session.exitCode ?? 'Not reported'}</dd>
        </dl>
      </Modal>}
      <div ref={sidebarRef} className={`workspace-explorer${explorerOpen ? '' : ' is-exiting'}`}
        aria-hidden={!explorerOpen || undefined}>
      {sidebarPresence.present && (
          <ApiProvider value={explorerApi}>
            <Explorer
              live={live}
              activeSessionId={activeSessionId}
              activeTab={tabs.find((tab) => tab.id === tabState.activeId) ?? null}
              names={names}
              onOpenSession={openSession}
              onOpenFeature={openFeature}
              onOpenPrReview={openReviewBoard}
              onOpenBulkPrReview={openBulkPrReview}
              onOpenAgent={openAgent}
              onOpenRepo={openRepo}
              onRenameSession={renameSession}
              onRenameFeature={renameFeature}
              onDeleteFeature={deleteFeature}
              onDeleteSession={deleteSession}
              onCollapse={toggleExplorer}
            />
          </ApiProvider>
      )}
      </div>
      {explorerOpen && (
          <PaneResizer
            className="explorer-resizer"
            label="Resize sidebar"
            value={explorerWidth}
            min={200}
            max={560}
            resetValue={260}
            onChange={setExplorerWidth}
          />
      )}

      <section className="editor">
        {(tabs.length > 0 || fullscreen) && (
          <div className="workspace-tab-strip"><div className="tabs" role="tablist" aria-label="Workspace tabs">
            {tabGroups.map((group) => {
              const grouped = group.label !== null && group.tabs.length > 1;
              const expanded = openTabGroups[group.id] ?? false;
              return <div className={grouped ? 'tab-group' : 'tab-group-single'} key={group.id}>
                {grouped && <button type="button" className="tab-group-toggle"
                  aria-label={`${group.label} tabs (${group.tabs.length})`} aria-expanded={expanded}
                  onClick={() => setOpenTabGroups((current) => ({ ...current, [group.id]: !expanded }))}>
                  <PullRequestIcon size={14} /><span>{group.label}</span>
                  <span className="tab-group-count">{group.tabs.length}</span><ChevronIcon size={12} open={expanded} />
                </button>}
                {group.tabs.filter((tab) => !grouped || expanded || tab.id === activeId || tab.id === splitId).map((tab) => (
              <div
                key={tab.id}
                className={`tab ${tab.id === activeId ? 'tab-active' : ''}`.trim()}
                style={
                  { '--feature-accent': featureColor(tabFeatureId(tab)) } as CSSProperties
                }
                onContextMenu={(event) => openTabMenu(event, tab.id)}
              >
                <button
                  type="button"
                  className="tab-label"
                  role="tab"
                  id={`${workspaceId}-tab-${tab.id}`}
                  aria-controls={`${workspaceId}-panel-${tab.id}`}
                  tabIndex={tab.id === activeId ? 0 : -1}
                  ref={(button) => {
                    if (button) tabButtons.current.set(tab.id, button);
                    else tabButtons.current.delete(tab.id);
                  }}
                  aria-selected={tab.id === activeId}
                  onKeyDown={(event) => {
                    const index = orderedTabs.findIndex((item) => item.id === tab.id);
                    let next: WorkspaceTab | undefined;
                    if (event.key === 'ArrowRight') next = orderedTabs[(index + 1) % orderedTabs.length];
                    else if (event.key === 'ArrowLeft') next = orderedTabs[(index - 1 + orderedTabs.length) % orderedTabs.length];
                    else if (event.key === 'Home') next = orderedTabs[0];
                    else if (event.key === 'End') next = orderedTabs[orderedTabs.length - 1];
                    else if (event.key === 'Delete') {
                      event.preventDefault();
                      closeTab(tab.id);
                    }
                    if (next) {
                      event.preventDefault();
                      const target = tabGroups.find((item) => item.tabs.some((tab) => tab.id === next!.id))!;
                      setOpenTabGroups((current) => ({ ...current, [target.id]: true }));
                      pendingTabFocus.current = next.id;
                      setTabState((prev) => setWorkspaceSplit({ ...prev, activeId: next.id }, prev.splitId));
                    }
                  }}
                  onClick={() =>
                    setTabState((prev) =>
                      setWorkspaceSplit({ ...prev, activeId: tab.id }, prev.splitId),
                    )
                  }
                >
                  <span
                    className={`tab-dot tab-dot-${tab.kind}`}
                    aria-hidden="true"
                  />
                  <span className="tab-label-text">
                    {tabDisplayLabel(tab)}
                  </span>
                </button>
                {canPopOut && isPoppableTab(tab) && (
                  <Tooltip label="Open in separate window"><button
                    type="button"
                    className="tab-popout"
                    aria-label={`Open ${tab.label} in a separate window`}
                    title="Open in separate window"
                    onClick={() => popOutTab(tab, tabDisplayLabel(tab))}
                  >
                    <PopOutIcon size={13} />
                  </button></Tooltip>
                )}
                {tab.id === splitId ? (
                  <Tooltip label="Close side-by-side view"><button
                    type="button"
                    className="tab-split tab-split-active"
                    aria-label={`Close side-by-side view of ${tab.label}`}
                    title="Showing in side pane · click to close split"
                    onClick={() => closeSplit()}
                  >
                    <CollapseRightPanelIcon size={14} />
                  </button></Tooltip>
                ) : (
                  tab.id !== activeId && (
                    <Tooltip label="Open side by side"><button
                      type="button"
                      className="tab-split"
                      aria-label={`Open ${tab.label} to the side`}
                      title="Open to the side"
                      onClick={() => openToSide(tab.id)}
                    >
                      <SplitViewIcon size={14} />
                    </button></Tooltip>
                  )
                )}
                <Tooltip label={`Close ${tabDisplayLabel(tab)}`}><button
                  type="button"
                  className="tab-close"
                  aria-label={`Close ${tab.label}`}
                  onClick={() => closeTab(tab.id)}
                >
                  <CloseIcon size={14} />
                </button></Tooltip>
                {tab.id === activeId && (
                  <Tooltip label="Tab actions"><button type="button" className="tab-menu-trigger"
                    aria-label={`Actions for ${tabDisplayLabel(tab)}`} aria-haspopup="menu"
                    aria-expanded={tabMenu?.tabId === tab.id}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setTabMenu({ tabId: tab.id, x: rect.left, y: rect.bottom + 4 });
                      event.stopPropagation();
                    }}>
                    <MoreIcon size={14} />
                  </button></Tooltip>
                )}
              </div>
            ))}</div>;
            })}
          </div>
          {fullscreen && <div className="workspace-fullscreen-controls" role="group" aria-label="Fullscreen controls">
            <button type="button" className="tree-action" aria-label={explorerOpen ? 'Hide explorer' : 'Show explorer'}
              title={explorerOpen ? 'Hide explorer' : 'Show explorer'} aria-pressed={explorerOpen} onClick={toggleExplorer}><CollapseSidebarIcon size={15} /></button>
            <button type="button" className="tree-action" aria-label={fullscreenRightOpen ? 'Hide prompt history' : 'Show prompt history'}
              title={fullscreenRightOpen ? 'Hide prompt history' : 'Show prompt history'} aria-pressed={fullscreenRightOpen}
              disabled={!activeSessionId} onClick={() => setFullscreenRightOpen((value) => !value)}><CollapseRightPanelIcon size={15} /></button>
            <button type="button" className="tree-action" aria-label="Exit fullscreen" title="Exit fullscreen (Esc)"
              onClick={() => void toggleFullscreen()}><RestoreIcon size={15} /></button>
          </div>}</div>
        )}
        {tabMenu &&
          (() => {
            const index = orderedTabs.findIndex((tab) => tab.id === tabMenu.tabId);
            if (index < 0) {
              return null;
            }
            const hasLeft = index > 0;
            const hasRight = index < orderedTabs.length - 1;
            const menuTabId = tabMenu.tabId;
            const runAction = (
              action: (state: WorkspaceTabsState, id: string) => WorkspaceTabsState,
            ) => {
              const run = (state: WorkspaceTabsState) => action({
                ...state, tabs: groupWorkspaceTabs(state.tabs).flatMap((group) => group.tabs),
              }, menuTabId);
              pendingTabFocus.current = run(tabState).activeId ?? '';
              setTabState(run);
              setTabMenu(null);
            };
            return (
              <div
                ref={tabMenuRef}
                className="tab-context-menu"
                role="menu"
                aria-label="Tab actions"
                style={{ left: tabMenu.x, top: tabMenu.y }}
                onClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.preventDefault()}
                onKeyDown={(event) => {
                  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
                  const index = items.findIndex((item) => item === document.activeElement);
                  let next: HTMLButtonElement | undefined;
                  if (event.key === 'ArrowDown') next = items[(index + 1) % items.length];
                  else if (event.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
                  else if (event.key === 'Home') next = items[0];
                  else if (event.key === 'End') next = items[items.length - 1];
                  else if (event.key === 'Tab') setTabMenu(null);
                  if (next) { event.preventDefault(); next.focus(); }
                }}
              >
                <button type="button" role="menuitem" className="tab-context-item"
                  onClick={() => void toggleFullscreen(menuTabId)}>
                  <ExpandIcon size={14} />{fullscreen ? 'Exit fullscreen' : 'Fullscreen tab'}
                </button>
                {orderedTabs[index]?.kind === 'session' && <>
                  <button type="button" role="menuitem" className="tab-context-item" onClick={() => {
                    tabButtons.current.get(menuTabId)?.focus();
                    setSessionDetailsId(menuTabId); setTabMenu(null);
                  }}>Session details</button>
                  <button type="button" role="menuitem" className="tab-context-item" onClick={() => {
                    const tab = orderedTabs[index];
                    if (tab?.kind === 'session') {
                      setTabState((state) => ({ ...state, activeId: tab.id }));
                      setTerminalDiagnosticsId(tab.session.id);
                    }
                    setTabMenu(null);
                  }}>Terminal diagnostics</button>
                </>}
                <button
                  type="button"
                  role="menuitem"
                  className="tab-context-item"
                  onClick={() => runAction(closeWorkspaceTab)}
                >
                  Close this
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="tab-context-item"
                  disabled={!hasLeft}
                  onClick={() => runAction(closeWorkspaceTabsToLeft)}
                >
                  Close tabs to the left
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="tab-context-item"
                  disabled={!hasRight}
                  onClick={() => runAction(closeWorkspaceTabsToRight)}
                >
                  Close tabs to the right
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="tab-context-item tab-context-item-danger"
                  onClick={() => runAction(closeAllWorkspaceTabs)}
                >
                  Close all
                </button>
              </div>
            );
          })()}
        {tabs.filter((tab) => tab.id !== activeId && tab.id !== splitId).map((tab) => (
          <div key={tab.id} hidden role="tabpanel" id={`${workspaceId}-panel-${tab.id}`}
            aria-labelledby={`${workspaceId}-tab-${tab.id}`} />
        ))}
        <div ref={editorBodyRef} tabIndex={-1} className={`editor-body${splitTab ? ' is-split' : ''}`}>
          <div className="editor-pane" role={active ? 'tabpanel' : undefined}
            id={active ? `${workspaceId}-panel-${active.id}` : undefined}
            aria-labelledby={active ? `${workspaceId}-tab-${active.id}` : undefined}
            tabIndex={active ? 0 : undefined}
            style={splitTab ? { flexGrow: splitRatio } : undefined}>
            {splitTab && active && (
              <div className="pane-header">
                <span
                  className={`tab-dot tab-dot-${active.kind}`}
                  style={
                    { '--feature-accent': featureColor(tabFeatureId(active)) } as CSSProperties
                  }
                  aria-hidden="true"
                />
                <span className="pane-header-label">
                  {tabDisplayLabel(active)}
                </span>
              </div>
            )}
            <div className="pane-content">
              {active ? (
                renderTabBody(active)
              ) : (
                <div className="editor-empty">
                  <EmptyState
                    icon={<AiMagicIcon size={28} />}
                    title="Your AI workspace awaits"
                    description="Pick a feature in the sidebar to launch a live CLI session, then watch usage and cost update in real time."
                  />
                  <ul className="editor-empty-tips">
                    <li>
                      <span className="editor-empty-tip-key">New session</span>
                      opens a live CLI terminal for the selected feature
                    </li>
                    <li>
                      <span className="editor-empty-tip-key">Usage</span>
                      tracks tokens, cost, and quota across your CLIs
                    </li>
                    <li>
                      <span className="editor-empty-tip-key"><SplitViewIcon size={14} /></span>
                      on any tab opens it side by side
                    </li>
                  </ul>
                </div>
              )}
            </div>
          </div>
          {splitTab && (
            <PaneResizer
              className="editor-split-resizer"
              label="Resize split view"
              value={splitRatio}
              min={25}
              max={75}
              resetValue={50}
              units="percent"
              dragScale={() => Math.max(0, (editorBodyRef.current?.clientWidth ?? 0) - 7) / 100}
              onChange={setSplitRatio}
            />
          )}
          {splitTab && (
            <div className="editor-pane editor-pane-secondary" role="tabpanel"
              id={`${workspaceId}-panel-${splitTab.id}`}
              aria-labelledby={`${workspaceId}-tab-${splitTab.id}`} tabIndex={0}
              style={{ flexGrow: 100 - splitRatio }}>
              <div className="pane-header">
                <span
                  className={`tab-dot tab-dot-${splitTab.kind}`}
                  style={
                    { '--feature-accent': featureColor(tabFeatureId(splitTab)) } as CSSProperties
                  }
                  aria-hidden="true"
                />
                <span className="pane-header-label">
                  {tabDisplayLabel(splitTab)}
                </span>
                <button
                  type="button"
                  className="pane-header-close"
                  aria-label="Close split view"
                  title="Close split view"
                  onClick={() => closeSplit()}
                >
                  <CloseIcon size={14} />
                </button>
              </div>
              <div className="pane-content">{renderTabBody(splitTab)}</div>
            </div>
          )}
        </div>
      </section>
      <SessionHistoryPane sessionId={activeSessionId} open={fullscreen ? fullscreenRightOpen : undefined}
        onOpenChange={fullscreen ? setFullscreenRightOpen : undefined} hideCollapsed={fullscreen} />
    </div>
  );
}
