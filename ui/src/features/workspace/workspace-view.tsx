import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import type { LiveState } from '../../lib/stream.js';
import type { Feature, Repository, Session, AttachedAgent } from '../../lib/types.js';
import { createSessionNameStore } from '../../lib/session-names.js';
import { featureColor } from '../../lib/feature-color.js';
import { createDisposer } from '../../lib/disposer.js';
import { useApi } from '../../app/api-context.js';
import { usePersistentState } from '../../hooks/use-persistent-state.js';
import { clampNumber, isFiniteNumber } from '../../lib/persisted-state.js';
import { EmptyState } from '../../components/ui.js';
import { AiMagicIcon, PopOutIcon } from '../../components/icons.js';
import { desktopBridge } from '../../lib/desktop-bridge.js';
import { isPoppableTab, type PoppableTab } from './tab-popout.js';
import { ErrorBoundary } from '../../components/error-boundary.js';
import { ViewSkeleton } from '../../components/view-skeleton.js';
import { Explorer } from './explorer.js';
import { getAgentModule } from '../../agent-host/agent-registry.js';
import {
  closeWorkspaceTab,
  emptyWorkspaceTabsState,
  isWorkspaceTabsState,
  openWorkspaceTab,
  reconcileWorkspaceTabsState,
  removeFeatureWorkspaceTabs,
  setWorkspaceSplit,
  type WorkspaceTab,
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
}: {
  live: LiveState;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  reopen?: { tab: PoppableTab; label: string; nonce: number } | null;
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
  const activeId = tabState.activeId;

  useEffect(() => {
    const featureTabs = tabs.filter(
      (tab) =>
        tab.kind === 'feature' ||
        tab.kind === 'review-board' ||
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
    if (
      featureTabs.length === 0 &&
      sessionFeatureIds.length === 0 &&
      !hasRepoTabs
    ) {
      return;
    }

    let active = true;
    void (async () => {
      const [features, repos, sessionsByFeature] = await Promise.all([
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
      ]);
      if (!active) {
        return;
      }
      setTabState((prev) =>
        reconcileWorkspaceTabsState(prev, { features, repos, sessionsByFeature }),
      );
    })();

    return () => {
      active = false;
    };
  }, [
    api,
    setTabState,
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
    setTabState((prev) => closeWorkspaceTab(prev, id));
  }

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
    await api.deleteFeature(feature.id);
    setTabState((prev) => removeFeatureWorkspaceTabs(prev, feature.id));
  }

  async function deleteSession(session: Session) {
    await api.deleteSession(session.id);
    closeTab(session.id);
  }

  const active = tabs.find((t) => t.id === activeId) ?? null;
  const activeSessionId = active?.kind === 'session' ? active.session.id : null;
  const splitId = tabState.splitId ?? null;
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
            <TerminalView sessionId={tab.session.id} />
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
          <Suspense fallback={<ViewSkeleton label={agentModule.title} />}>
            <AgentComponent
              key={tab.id}
              ctx={{
                feature: tab.feature,
                attachmentId: tab.attachmentId,
                agentId: tab.agentId,
              }}
            />
          </Suspense>
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
    return null;
  }

  // Owns teardown for the imperative explorer-resize drag listeners so they are
  // removed even if the workspace unmounts while a drag is still in progress.
  const resizeDisposer = useRef(createDisposer());
  useEffect(() => {
    const disposer = resizeDisposer.current;
    return () => disposer.dispose();
  }, []);

  function startResize(event: ReactMouseEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = explorerWidth;
    // Global drag listeners are attached imperatively (not via an effect), so
    // route their teardown through a disposer that both the drag's own mouseup
    // and the unmount effect can trigger — no leak if we unmount mid-drag.
    const disposer = resizeDisposer.current;
    disposer.dispose();
    function onMove(move: MouseEvent) {
      const next = Math.min(560, Math.max(200, startWidth + (move.clientX - startX)));
      setExplorerWidth(next);
    }
    function onUp() {
      disposer.dispose();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.classList.add('is-resizing');
    disposer.add(() => document.removeEventListener('mousemove', onMove));
    disposer.add(() => document.removeEventListener('mouseup', onUp));
    disposer.add(() => document.body.classList.remove('is-resizing'));
  }

  return (
    <div
      className={`workspace ${sidebarOpen ? '' : 'is-collapsed'}`.trim()}
      style={
        sidebarOpen
          ? ({ '--explorer-width': `${explorerWidth}px` } as CSSProperties)
          : undefined
      }
    >
      {sidebarOpen && (
        <>
          <Explorer
            live={live}
            activeSessionId={activeSessionId}
            names={names}
            onOpenSession={openSession}
            onOpenFeature={openFeature}
            onOpenPrReview={openReviewBoard}
            onOpenAgent={openAgent}
            onOpenRepo={openRepo}
            onRenameSession={renameSession}
            onRenameFeature={renameFeature}
            onDeleteFeature={deleteFeature}
            onDeleteSession={deleteSession}
            onCollapse={onToggleSidebar}
          />
          <div
            className="explorer-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            title="Drag to resize · double-click to reset"
            onMouseDown={startResize}
            onDoubleClick={() => setExplorerWidth(260)}
          />
        </>
      )}

      <section className="editor">
        {tabs.length > 0 && (
          <div className="tabs" role="tablist">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`tab ${tab.id === activeId ? 'tab-active' : ''}`.trim()}
                style={
                  { '--feature-accent': featureColor(tabFeatureId(tab)) } as CSSProperties
                }
              >
                <button
                  type="button"
                  className="tab-label"
                  role="tab"
                  aria-selected={tab.id === activeId}
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
                  <button
                    type="button"
                    className="tab-popout"
                    aria-label={`Open ${tab.label} in a separate window`}
                    title="Open in separate window"
                    onClick={() => popOutTab(tab, tabDisplayLabel(tab))}
                  >
                    <PopOutIcon size={13} />
                  </button>
                )}
                {tab.id === splitId ? (
                  <button
                    type="button"
                    className="tab-split tab-split-active"
                    aria-label={`Close side-by-side view of ${tab.label}`}
                    title="Showing in side pane · click to close split"
                    onClick={() => closeSplit()}
                  >
                    ⊟
                  </button>
                ) : (
                  tab.id !== activeId && (
                    <button
                      type="button"
                      className="tab-split"
                      aria-label={`Open ${tab.label} to the side`}
                      title="Open to the side"
                      onClick={() => openToSide(tab.id)}
                    >
                      ⊞
                    </button>
                  )
                )}
                <button
                  type="button"
                  className="tab-close"
                  aria-label={`Close ${tab.label}`}
                  onClick={() => closeTab(tab.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className={`editor-body${splitTab ? ' is-split' : ''}`}>
          <div className="editor-pane">
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
                  <div className="editor-empty-art" aria-hidden="true" />
                  <EmptyState
                    icon={<AiMagicIcon size={28} />}
                    title="Your AI workspace awaits"
                    description="Open a session to launch its live CLI, or a feature to see usage analytics. Use the ⊞ on any tab to open it side by side."
                  />
                </div>
              )}
            </div>
          </div>
          {splitTab && (
            <div className="editor-pane editor-pane-secondary">
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
                  ×
                </button>
              </div>
              <div className="pane-content">{renderTabBody(splitTab)}</div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
