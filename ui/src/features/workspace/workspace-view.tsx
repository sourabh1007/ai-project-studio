import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import type { LiveState } from '../../lib/stream.js';
import type { Feature, Repository, Session } from '../../lib/types.js';
import { createSessionNameStore } from '../../lib/session-names.js';
import { featureColor } from '../../lib/feature-color.js';
import { createDisposer } from '../../lib/disposer.js';
import { useApi } from '../../app/api-context.js';
import { usePersistentState } from '../../hooks/use-persistent-state.js';
import { clampNumber, isFiniteNumber } from '../../lib/persisted-state.js';
import { EmptyState } from '../../components/ui.js';
import { AiMagicIcon } from '../../components/icons.js';
import { ErrorBoundary } from '../../components/error-boundary.js';
import { ViewSkeleton } from '../../components/view-skeleton.js';
import { Explorer } from './explorer.js';

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
const PrReviewPage = lazy(() =>
  import('../pr-review-page/pr-review-page.js').then((m) => ({
    default: m.PrReviewPage,
  })),
);
const ReviewBoardPage = lazy(() =>
  import('../review-board-page/review-board-page.js').then((m) => ({
    default: m.ReviewBoardPage,
  })),
);
const RepoDashboard = lazy(() =>
  import('../repo-dashboard/repo-dashboard.js').then((m) => ({
    default: m.RepoDashboard,
  })),
);

type Tab =
  | { kind: 'session'; id: string; label: string; session: Session }
  | { kind: 'feature'; id: string; label: string; feature: Feature }
  | { kind: 'pr-review'; id: string; label: string; feature: Feature }
  | { kind: 'review-board'; id: string; label: string; feature: Feature }
  | { kind: 'repo'; id: string; label: string; repo: Repository };

function featureTabId(featureId: string): string {
  return `feature:${featureId}`;
}

function prReviewTabId(featureId: string): string {
  return `pr-review:${featureId}`;
}

function reviewBoardTabId(featureId: string): string {
  return `review-board:${featureId}`;
}

function repoTabId(repoId: string): string {
  return `repo:${repoId}`;
}

/** The feature id a tab belongs to, for color-coding session and feature tabs. */
function tabFeatureId(tab: Tab): string {
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
}: {
  live: LiveState;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}) {
  const nameStore = useMemo(
    () => createSessionNameStore(window.localStorage),
    [],
  );
  const api = useApi();
  const [names, setNames] = useState<Record<string, string>>(() =>
    nameStore.all(),
  );
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [explorerWidth, setExplorerWidth] = usePersistentState(
    'cw-explorer-width',
    260,
    {
      validate: isFiniteNumber,
      normalize: (w) => clampNumber(w, 200, 560),
    },
  );

  function openTab(tab: Tab) {
    setTabs((prev) => (prev.some((t) => t.id === tab.id) ? prev : [...prev, tab]));
    setActiveId(tab.id);
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

  function openPrReview(feature: Feature) {
    openTab({
      kind: 'pr-review',
      id: prReviewTabId(feature.id),
      label: `Code Review · ${feature.name}`,
      feature,
    });
  }

  function openReviewBoard(feature: Feature) {
    openTab({
      kind: 'review-board',
      id: reviewBoardTabId(feature.id),
      label: `Review Board · ${feature.name}`,
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
    setTabs((prev) =>
      prev.map((tab) =>
        tab.kind === 'session' && tab.session.id === sessionId
          ? { ...tab, label: trimmed || tab.label }
          : tab,
      ),
    );
    return api
      .renameSession(sessionId, trimmed || null)
      .then((updated) => {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.kind === 'session' && tab.session.id === sessionId
              ? { ...tab, session: updated, label: updated.name ?? tab.label }
              : tab,
          ),
        );
      });
  }

  function closeTab(id: string) {
    setTabs((prev) => prev.filter((t) => t.id !== id));
    setActiveId((current) => {
      if (current !== id) {
        return current;
      }
      const remaining = tabs.filter((t) => t.id !== id);
      return remaining[remaining.length - 1]?.id ?? null;
    });
  }

  async function renameFeature(feature: Feature, name: string) {
    const updated = await api.renameFeature(feature.id, name);
    setTabs((prev) =>
      prev.map((tab) =>
        tab.kind === 'feature' && tab.feature.id === updated.id
          ? { ...tab, label: updated.name, feature: updated }
          : tab,
      ),
    );
  }

  async function deleteFeature(feature: Feature) {
    await api.deleteFeature(feature.id);
    setTabs((prev) => {
      const next = prev.filter(
        (tab) =>
          !(tab.kind === 'feature' && tab.feature.id === feature.id) &&
          !(tab.kind === 'pr-review' && tab.feature.id === feature.id) &&
          !(tab.kind === 'session' && tab.session.featureId === feature.id),
      );
      setActiveId((current) =>
        prev.some((t) => t.id === current) && !next.some((t) => t.id === current)
          ? (next[next.length - 1]?.id ?? null)
          : current,
      );
      return next;
    });
  }

  async function deleteSession(session: Session) {
    await api.deleteSession(session.id);
    closeTab(session.id);
  }

  const active = tabs.find((t) => t.id === activeId) ?? null;
  const activeSessionId = active?.kind === 'session' ? active.session.id : null;

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
            onOpenPrReview={openPrReview}
            onOpenReviewBoard={openReviewBoard}
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
                  onClick={() => setActiveId(tab.id)}
                >
                  <span
                    className={`tab-dot tab-dot-${tab.kind}`}
                    aria-hidden="true"
                  />
                  <span className="tab-label-text">
                    {tab.kind === 'session'
                      ? tab.session.name?.trim() ||
                        names[tab.session.id]?.trim() ||
                        tab.label
                      : tab.label}
                  </span>
                </button>
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
        <div className="editor-body">
          {active?.kind === 'session' && (
            <div key={active.session.id} className="session-editor">
              <Suspense fallback={<ViewSkeleton label="terminal" />}>
                <TerminalView sessionId={active.session.id} />
              </Suspense>
            </div>
          )}
          {active?.kind === 'feature' && (
            <Suspense fallback={<ViewSkeleton label="dashboard" />}>
              <FeatureDashboard
                key={active.feature.id}
                featureId={active.feature.id}
                featureName={active.feature.name}
                featureDescription={active.feature.description}
                contextPhase={
                  live.contextStatus[`feature:${active.feature.id}`]
                }
              />
            </Suspense>
          )}
          {active?.kind === 'pr-review' && (
            <ErrorBoundary label="Code Review">
              <Suspense fallback={<ViewSkeleton label="code review" />}>
                <PrReviewPage
                  key={active.feature.id}
                  featureId={active.feature.id}
                  liveReview={live.prReviews[active.feature.id]}
                />
              </Suspense>
            </ErrorBoundary>
          )}
          {active?.kind === 'review-board' && (
            <ErrorBoundary label="Review Board">
              <Suspense fallback={<ViewSkeleton label="review board" />}>
                <ReviewBoardPage
                  key={active.feature.id}
                  featureId={active.feature.id}
                  onOpenCodeReview={() => openPrReview(active.feature)}
                />
              </Suspense>
            </ErrorBoundary>
          )}
          {active?.kind === 'repo' && (
            <Suspense fallback={<ViewSkeleton label="repository" />}>
              <RepoDashboard key={active.repo.id} repo={active.repo} />
            </Suspense>
          )}
          {!active && (
            <div className="editor-empty">
              <div className="editor-empty-art" aria-hidden="true" />
              <EmptyState
                icon={<AiMagicIcon size={28} />}
                title="Your AI workspace awaits"
                description="Open a session to launch its live CLI, or a feature to see usage analytics."
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
