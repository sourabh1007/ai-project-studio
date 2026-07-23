import { useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import type { LiveState } from '../../lib/stream.js';
import type { Feature, Session } from '../../lib/types.js';
import { createSessionNameStore } from '../../lib/session-names.js';
import { featureColor } from '../../lib/feature-color.js';
import { useApi } from '../../app/api-context.js';
import { EmptyState } from '../../components/ui.js';
import { TerminalView } from '../../components/terminal-view.js';
import { FeatureDashboard } from '../feature-dashboard/feature-dashboard.js';
import { Explorer } from './explorer.js';

type Tab =
  | { kind: 'session'; id: string; label: string; session: Session }
  | { kind: 'feature'; id: string; label: string; feature: Feature };

function featureTabId(featureId: string): string {
  return `feature:${featureId}`;
}

/** The feature id a tab belongs to, for color-coding session and feature tabs. */
function tabFeatureId(tab: Tab): string {
  return tab.kind === 'session' ? tab.session.featureId : tab.feature.id;
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

  function renameSession(sessionId: string, name: string) {
    nameStore.set(sessionId, name);
    setNames(nameStore.all());
  }

  function closeTab(id: string) {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActiveId((current) =>
        current === id ? (next[next.length - 1]?.id ?? null) : current,
      );
      return next;
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
                    ? names[tab.session.id]?.trim() || tab.label
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
            <TerminalView key={active.session.id} sessionId={active.session.id} />
          )}
          {active?.kind === 'feature' && (
            <FeatureDashboard
              key={active.feature.id}
              featureId={active.feature.id}
              featureName={active.feature.name}
            />
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
