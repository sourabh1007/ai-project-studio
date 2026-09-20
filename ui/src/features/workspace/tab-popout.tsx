import { lazy, Suspense } from 'react';
import type { WorkspaceTab } from './workspace-tabs.js';
import { ViewSkeleton } from '../../components/view-skeleton.js';
import { EmptyState } from '../../components/ui.js';
import { AiMagicIcon, PopInIcon } from '../../components/icons.js';
import { ErrorBoundary } from '../../components/error-boundary.js';
import { getAgentModule } from '../../agent-host/agent-registry.js';
import { desktopBridge } from '../../lib/desktop-bridge.js';

const TerminalView = lazy(() =>
  import('../../components/terminal-view.js').then((m) => ({
    default: m.TerminalView,
  })),
);

/** The workspace tabs that can be torn out into their own OS window. */
export type PoppableTab = Extract<WorkspaceTab, { kind: 'session' | 'agent' }>;

/** True for the tab kinds a detached window knows how to host on its own. */
export function isPoppableTab(tab: WorkspaceTab): tab is PoppableTab {
  return tab.kind === 'session' || tab.kind === 'agent';
}

function tabTitle(tab: PoppableTab, label: string): string {
  const trimmed = label.trim();
  if (trimmed) {
    return trimmed;
  }
  if (tab.kind === 'session') {
    return tab.session.name?.trim() || 'Session';
  }
  return tab.label || 'Agent';
}

function TabBody({ tab }: { tab: PoppableTab }) {
  if (tab.kind === 'session') {
    return (
      <Suspense fallback={<ViewSkeleton label="terminal" />}>
        <TerminalView sessionId={tab.session.id} />
      </Suspense>
    );
  }
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

/**
 * Standalone host for a single workspace tab torn out of the IDE into its own
 * OS window — a session's live terminal or an agent board. A slim header offers
 * a "return to IDE" control. The tab's state lives in the shared backend, so
 * this window drives the same session/agent the in-IDE tab would.
 */
export function TabPopout({
  tab,
  label,
}: {
  tab: PoppableTab;
  label: string;
}) {
  const title = tabTitle(tab, label);
  function popIn() {
    void desktopBridge()?.windows?.popIn?.();
  }
  return (
    <div className="session-popout">
      <header className="session-popout-header">
        <span
          className={`session-popout-dot tab-dot-${tab.kind}`}
          aria-hidden="true"
        />
        <span className="session-popout-title" title={title}>
          {title}
        </span>
        <button
          type="button"
          className="ghost-button tone-accent session-popout-return"
          onClick={popIn}
          title="Return this tab to the main window"
        >
          <PopInIcon size={14} />
          Return to IDE
        </button>
      </header>
      <div className="session-popout-body">
        <TabBody tab={tab} />
      </div>
    </div>
  );
}

/**
 * Parses the pop-out payload the main process encoded into the URL hash when it
 * spawned this window. Returns null when this is not a tab pop-out window or the
 * payload is malformed, so the caller falls back to the full IDE.
 */
export function readTabPopoutFromLocation(
  search: string,
  hash: string,
): { tab: PoppableTab; label: string } | null {
  const params = new URLSearchParams(search);
  if (params.get('popout') !== 'tab') {
    return null;
  }
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as {
      tab?: unknown;
      label?: unknown;
    };
    const tab = parsed.tab as WorkspaceTab | undefined;
    if (!tab || typeof tab !== 'object' || typeof tab.id !== 'string') {
      return null;
    }
    if (!isPoppableTab(tab)) {
      return null;
    }
    return {
      tab,
      label: typeof parsed.label === 'string' ? parsed.label : '',
    };
  } catch {
    return null;
  }
}
