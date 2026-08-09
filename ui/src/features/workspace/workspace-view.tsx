import { useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import type { LiveState } from '../../lib/stream.js';
import type { Feature, Repository, Session } from '../../lib/types.js';
import { createSessionNameStore } from '../../lib/session-names.js';
import { featureColor } from '../../lib/feature-color.js';
import { useApi } from '../../app/api-context.js';
import { EmptyState } from '../../components/ui.js';
import { ErrorBoundary } from '../../components/error-boundary.js';
import { TerminalView } from '../../components/terminal-view.js';
import { FeatureDashboard } from '../feature-dashboard/feature-dashboard.js';
import { PrReviewPage } from '../pr-review-page/pr-review-page.js';
import { RepoDashboard } from '../repo-dashboard/repo-dashboard.js';
import { Explorer } from './explorer.js';

type Tab =
  | { kind: 'session'; id: string; label: string; session: Session }
  | { kind: 'feature'; id: string; label: string; feature: Feature }
  | { kind: 'pr-review'; id: string; label: string; feature: Feature }
  | { kind: 'repo'; id: string; label: string; repo: Repository };

function featureTabId(featureId: string): string {
  return `feature:${featureId}`;
}

function prReviewTabId(featureId: string): string {
  return `pr-review:${featureId}`;
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
  const [explorerWidth, setExplorerWidth] = useState(260);

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
      label: `PR Review · ${feature.name}`,
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

  function startResize(event: ReactMouseEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = explorerWidth;
    function onMove(move: MouseEvent) {
      const next = Math.min(560, Math.max(200, startWidth + (move.clientX - startX)));
      setExplorerWidth(next);
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('is-resizing');
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.classList.add('is-resizing');
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
                  {tab.kind === 'session'
                    ? tab.session.name?.trim() ||
                      names[tab.session.id]?.trim() ||
                      tab.label
                    : tab.label}
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
              <TerminalView sessionId={active.session.id} />
            </div>
          )}
          {active?.kind === 'feature' && (
            <FeatureDashboard
              key={active.feature.id}
              featureId={active.feature.id}
              featureName={active.feature.name}
              featureDescription={active.feature.description}
              contextPhase={
                live.contextStatus[`feature:${active.feature.id}`]
              }
            />
          )}
          {active?.kind === 'pr-review' && (
            <ErrorBoundary label="PR Review">
              <PrReviewPage
                key={active.feature.id}
                featureId={active.feature.id}
                liveReview={live.prReviews[active.feature.id]}
              />
            </ErrorBoundary>
          )}
          {active?.kind === 'repo' && (
            <RepoDashboard key={active.repo.id} repo={active.repo} />
          )}
          {!active && (
            <div className="editor-empty">
              <div className="editor-empty-art" aria-hidden="true" />
              <EmptyState message="Open a session to launch its live CLI, or a feature to see analytics." />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
