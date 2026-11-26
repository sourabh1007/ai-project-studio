import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrandedLoader } from './components/loading.js';
import { MonitoringProvider } from './features/monitoring/monitoring-host.js';
import { useApi } from './app/api-context.js';
import { failActivity } from './lib/activity.js';
import { reviewBoardRunStore } from './features/review-board-page/review-board-run-store.js';
import { ActiveSessionsStatus } from './features/status-bar/active-sessions-status.js';
import type { ActiveSessionEntry } from './features/active-sessions/active-session-types.js';
import { useUsageStream } from './hooks/use-usage-stream.js';
import { useTheme } from './hooks/use-theme.js';
import { useGlobalClipboard } from './hooks/use-global-clipboard.js';
import { themeModeLabel } from './lib/theme.js';
import { useIdeUsage } from './hooks/use-ide-usage.js';
import { usePlanUsage } from './hooks/use-plan-usage.js';
import { liveSignal } from './lib/stream.js';
import { formatAic } from './lib/format.js';
import { ConnectionBanner } from './components/connection-banner.js';
import { BrandMark } from './components/brand-mark.js';
import { Tooltip } from './components/tooltip.js';
import { UpdateBanner } from './features/updates/update-banner.js';
import { OperationNoticeBanner } from './components/operation-notice-banner.js';
import { FeatureDeletionStatus } from './features/workspace/feature-deletion-status.js';
import { AgencyUpdatePopup } from './features/updates/agency-update-popup.js';
import { OPEN_PROMPT_SETTINGS_EVENT } from './features/settings/prompts-nav.js';
import { OPEN_PROMPT_USAGE_EVENT, type PromptUsageTarget } from './features/usage/prompt-usage.js';
import { OPEN_TOOL_OWNER_EVENT } from './features/settings/tools-section.js';
import { ViewSkeleton } from './components/view-skeleton.js';
import { useMicrosoftIdentitySync } from './hooks/use-microsoft-identity.js';
import { CliSelector } from './features/bootstrap/cli-selector.js';
import { CLI_SHORTCUT_CHANGED, CLI_SHORTCUT_KEY, PROVIDER_CHANGED, PROVIDER_PREFERENCES_CHANGED, cliShortcutBinding, cliShortcutLabel, isCliShortcut, ownsCliShortcut, type CliShortcut } from './lib/provider-selection.js';
import type { ProviderSelectionInfo } from './lib/api.js';

// Heavy views are code-split so the initial bundle stays small and non-active
// views never load until first navigated to. Each import maps a named export to
// the default shape React.lazy expects.
const WorkspaceView = lazy(() =>
  import('./features/workspace/workspace-view.js').then((m) => ({
    default: m.WorkspaceView,
  })),
);
const SettingsView = lazy(() =>
  import('./features/settings/settings-view.js').then((m) => ({
    default: m.SettingsView,
  })),
);
const SkillsManager = lazy(() =>
  import('./features/skills/skills-manager.js').then((m) => ({
    default: m.SkillsManager,
  })),
);
const McpManager = lazy(() =>
  import('./features/mcp/mcp-manager.js').then((m) => ({
    default: m.McpManager,
  })),
);
const AutomationsView = lazy(() =>
  import('./features/automations/automations-view.js').then((m) => ({
    default: m.AutomationsView,
  })),
);
const UsageView = lazy(() =>
  import('./features/usage/usage-view.js').then((m) => ({
    default: m.UsageView,
  })),
);
const AgentsView = lazy(() =>
  import('./features/agents/agents-view.js').then((m) => ({
    default: m.AgentsView,
  })),
);
const PlannerView = lazy(() =>
  import('./features/planner/planner-view.js').then((m) => ({
    default: m.PlannerView,
  })),
);
import {
  CommandPalette,
  type PaletteCommand,
} from './components/command-palette.js';
import { ShortcutsSheet } from './components/shortcuts-sheet.js';
import { NetworkCenter } from './features/network-center/network-center.js';
import { MetaModelStatus } from './features/status-bar/meta-model-status.js';
import { ResourceStatus } from './features/status-bar/resource-status.js';
import { ActivityStatus } from './features/status-bar/activity-status.js';
import { useConnectionStatus } from './hooks/use-connection-status.js';
import { PlanUsageIndicator } from './components/plan-usage-indicator.js';
import {
  matchShortcut,
  type ShortcutBinding,
} from './lib/keyboard-shortcuts.js';
import { usePersistentState } from './hooks/use-persistent-state.js';
import { useApplyUiPreferences } from './hooks/use-ui-preferences.js';
import { isOneOf } from './lib/persisted-state.js';
import { hasOpenModalDialog } from './lib/focus-ownership.js';
import { desktopBridge } from './lib/desktop-bridge.js';
import type { PoppableTab } from './features/workspace/tab-popout.js';
import type { WorkspaceLaunchIntent } from './lib/planner-launch.js';
import {
  AutomationIcon,
  AiChatIcon,
  CollapseSidebarIcon,
  FilesIcon,
  McpIcon,
  MoonIcon,
  PlannerIcon,
  SettingsIcon,
  SessionIcon,
  SkillsIcon,
  SunIcon,
  UsageIcon,
} from './components/icons.js';

type View = 'workspace' | 'planner' | 'skills' | 'mcp' | 'automations' | 'usage' | 'agents' | 'settings';

/** View cycle order for Ctrl+Tab / Ctrl+Shift+Tab. */
const VIEW_ORDER: View[] = ['workspace', 'planner', 'skills', 'mcp', 'automations', 'usage', 'agents', 'settings'];

/** The global keyboard shortcuts, shown in the discoverable shortcuts sheet. */
const SHORTCUT_BINDINGS: ShortcutBinding[] = [
  { id: 'palette', title: 'Open command palette', key: 'k', ctrlOrMeta: true },
  { id: 'quick-open', title: 'Quick open', key: 'p', ctrlOrMeta: true },
  { id: 'next-view', title: 'Next view', key: 'Tab', ctrlOrMeta: true },
  { id: 'prev-view', title: 'Previous view', key: 'Tab', ctrlOrMeta: true, shift: true },
  { id: 'toggle-sidebar', title: 'Toggle sidebar', key: 'b', ctrlOrMeta: true },
  { id: 'open-settings', title: 'Open settings', key: ',', ctrlOrMeta: true },
  { id: 'show-shortcuts', title: 'Show keyboard shortcuts', key: '/', ctrlOrMeta: true },
];

export function App() {
  const [promptUsageTarget, setPromptUsageTarget] = useState<PromptUsageTarget>();
  const api = useApi();
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => api.getPendingReviewBoards()).then((ids) => {
      if (!cancelled) reviewBoardRunStore.enqueueBulk(ids, api);
    }).catch((error) => {
      if (!cancelled) failActivity(error instanceof Error ? error.message : 'Could not restore pending PR reviews.');
    });
    return () => { cancelled = true; };
  }, [api]);
  const live = useUsageStream();
  useMicrosoftIdentitySync();
  const [internalAgencyAvailable, setInternalAgencyAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    const changed = (event: Event) => {
      const info = (event as CustomEvent<ProviderSelectionInfo>).detail;
      setInternalAgencyAvailable(info.providers.some((provider) => provider.id === 'agency'));
    };
    void Promise.resolve().then(() => api.getProviderBootstrap()).then((info) => {
      if (active) setInternalAgencyAvailable(info.providers.some((provider) => provider.id === 'agency'));
    }).catch(() => {});
    window.addEventListener(PROVIDER_PREFERENCES_CHANGED, changed);
    return () => {
      active = false;
      window.removeEventListener(PROVIDER_PREFERENCES_CHANGED, changed);
    };
  }, [api]);
  const { mode, theme, cycle, toggle } = useTheme();
  useApplyUiPreferences(theme);
  const [view, setView] = usePersistentState<View>('cw-active-view', 'workspace', {
    validate: isOneOf(VIEW_ORDER),
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dockVisible, setDockVisible] = usePersistentState('cw-dock-visible', true, {
    validate: (value): value is boolean => typeof value === 'boolean',
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [cliOpen, setCliOpen] = useState(false);
  const [cliShortcut, setCliShortcut] = usePersistentState<CliShortcut>(CLI_SHORTCUT_KEY, 'l', { validate: isCliShortcut });
  const [providerSwitch, setProviderSwitch] = useState<{ providerId: string; nonce: number } | null>(null);
  const shortcutBindings = useMemo(() => [...SHORTCUT_BINDINGS, ...cliShortcutBinding(cliShortcut)], [cliShortcut]);
  useEffect(() => {
    const changed = (event: Event) => {
      const info = (event as CustomEvent<ProviderSelectionInfo>).detail;
      setProviderSwitch((previous) => ({ providerId: info.defaultProvider, nonce: (previous?.nonce ?? 0) + 1 }));
      setView('workspace');
    };
    const shortcutChanged = (event: Event) => {
      const value: unknown = (event as CustomEvent<unknown>).detail;
      if (isCliShortcut(value)) setCliShortcut(value);
    };
    window.addEventListener(PROVIDER_CHANGED, changed);
    window.addEventListener(CLI_SHORTCUT_CHANGED, shortcutChanged);
    return () => {
      window.removeEventListener(PROVIDER_CHANGED, changed);
      window.removeEventListener(CLI_SHORTCUT_CHANGED, shortcutChanged);
    };
  }, [setView, setCliShortcut]);
  const [worktreesRequest, setWorktreesRequest] = useState<number>();
  const [capacityRequest, setCapacityRequest] = useState<number>();
  const monitoringRestore = useRef<() => void>(() => {});
  const [monitoringOwnerKey, setMonitoringOwnerKey] = useState('');
  const captureMonitoringOrigin = useCallback((restore: () => void, key: string) => {
    monitoringRestore.current = restore;
    setMonitoringOwnerKey(key);
  }, []);
  const [monitoringOrigin, setMonitoringOrigin] = useState<{ view: View; restore?: () => void } | null>(null);
  function rememberMonitoringOrigin() {
    setMonitoringOrigin((previous) => previous ?? { view, restore: view === 'workspace' ? monitoringRestore.current : undefined });
  }
  // A tab returned from a detached ("popped out") window re-opens in the
  // workspace. The nonce lets the workspace treat repeated returns of the same
  // tab as distinct events.
  const [reopenTab, setReopenTab] = useState<{
    tab: PoppableTab;
    label: string;
    nonce: number;
  } | null>(null);
  // A launch requested from the Planner is handed to the workspace view, which
  // opens the matching tab. The nonce makes repeated launches distinct events.
  const [workspaceLaunch, setWorkspaceLaunch] = useState<{
    intent: WorkspaceLaunchIntent;
    nonce: number;
  } | null>(null);
  function launchInWorkspace(intent: WorkspaceLaunchIntent) {
    setWorkspaceLaunch((prev) => ({ intent, nonce: (prev?.nonce ?? 0) + 1 }));
    setView('workspace');
  }
  async function openActiveSession(entry: ActiveSessionEntry) {
    try {
      if (entry.kind !== 'session' || !entry.sessionId) {
        throw new Error('IDE sessions can only be opened in the read-only debugger.');
      }
      const session = await api.getSession(entry.sessionId);
      if (session.kind === 'meta' || session.status !== 'running') {
        throw new Error('This session is no longer an active workspace terminal.');
      }
      setView('workspace');
      setSidebarOpen(true);
      setReopenTab({
        tab: { kind: 'session', id: session.id, label: entry.label, session },
        label: entry.label, nonce: Date.now(),
      });
    } catch (error) {
      failActivity(error instanceof Error ? error.message : 'Could not open active session. Refresh the list and retry.');
    }
  }

  useEffect(() => {
    const windows = desktopBridge()?.windows;
    if (!windows?.onReturn) {
      return undefined;
    }
    return windows.onReturn((payload) => {
      const tab = payload?.tab as PoppableTab | undefined;
      if (!tab || typeof tab.id !== 'string') {
        return;
      }
      setView('workspace');
      setSidebarOpen(true);
      setReopenTab({
        tab,
        label: typeof payload.label === 'string' ? payload.label : '',
        nonce: Date.now(),
      });
    });
  }, [setView]);

  // App-wide clipboard hardening so Ctrl/Cmd+C on any selected UI text reaches
  // the OS clipboard (the app's non-secure localhost origin disables the web
  // Clipboard API). See use-global-clipboard.
  const clipboardError = useGlobalClipboard();

  const cycleView = (delta: number) => {
    setView((current) => {
      const index = VIEW_ORDER.indexOf(current);
      const next =
        VIEW_ORDER[(index + delta + VIEW_ORDER.length) % VIEW_ORDER.length];
      if (next === 'workspace') {
        setSidebarOpen(true);
      }
      return next;
    });
  };

  // Single global shortcut handler driven by the shared, tested binding table.
  // Keeps all app-level chords in one place instead of scattered listeners.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (hasOpenModalDialog()) {
        return;
      }
      const binding = matchShortcut(event, shortcutBindings);
      if (!binding) return;
      if (binding.id === 'switch-cli' && !ownsCliShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      switch (binding.id) {
        case 'switch-cli':
          setCliOpen((prev) => !prev);
          break;
        case 'palette':
        case 'quick-open':
          setPaletteOpen((prev) => !prev);
          break;
        case 'next-view':
          cycleView(1);
          break;
        case 'prev-view':
          cycleView(-1);
          break;
        case 'toggle-sidebar':
          setSidebarOpen((prev) => !prev);
          break;
        case 'open-settings':
          setView('settings');
          break;
        case 'show-shortcuts':
          setShortcutsOpen((prev) => !prev);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [shortcutBindings]);

  // A prompt "Edit in Settings" deep-link can fire from any view (e.g. the
  // review board inside the workspace); switch to Settings so its own listener
  // can open the Prompts & Commands tab and scroll to the entry.
  useEffect(() => {
    const onPromptUsage = (event: Event) => {
      const promptRef: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof promptRef !== 'string' || promptRef.length === 0 || promptRef.length > 200) return;
      setPromptUsageTarget((previous) => ({ promptRef, nonce: (previous?.nonce ?? 0) + 1 }));
      setView('usage');
    };
    window.addEventListener(OPEN_PROMPT_USAGE_EVENT, onPromptUsage);
    return () => window.removeEventListener(OPEN_PROMPT_USAGE_EVENT, onPromptUsage);
  }, [setView]);
  useEffect(() => {
    const onOpenPromptSettings = () => setView('settings');
    window.addEventListener(
      OPEN_PROMPT_SETTINGS_EVENT,
      onOpenPromptSettings,
    );
    return () =>
      window.removeEventListener(
        OPEN_PROMPT_SETTINGS_EVENT,
        onOpenPromptSettings,
      );
  }, [setView]);

  useEffect(() => {
    const openOwner = (event: Event) => {
      const owner = (event as CustomEvent<unknown>).detail;
      if (owner === 'mcp' || owner === 'automations') setView(owner);
    };
    window.addEventListener(OPEN_TOOL_OWNER_EVENT, openOwner);
    return () => window.removeEventListener(OPEN_TOOL_OWNER_EVENT, openOwner);
  }, [setView]);

  const commands = useMemo<PaletteCommand[]>(() => {
    const goto = (next: View) => () => {
      setView(next);
      if (next === 'workspace') {
        setSidebarOpen(true);
      }
    };
    return [
      { id: 'view-monitoring', title: 'Open monitoring insights', section: 'Navigation',
        keywords: ['monitoring', 'telemetry', 'timeline', 'capacity', 'usage'], run: goto('usage') },
      {
        id: 'view-workspace',
        title: 'Open Explorer',
        section: 'Navigation',
        keywords: ['workspace', 'files', 'sessions'],
        run: goto('workspace'),
      },
      {
        id: 'view-planner',
        title: 'Open Planner',
        section: 'Navigation',
        keywords: ['tasks', 'checklist', 'todo', 'priority'],
        run: goto('planner'),
      },
      {
        id: 'view-skills',
        title: 'Open Skills',
        section: 'Navigation',
        keywords: ['prompts'],
        run: goto('skills'),
      },
      {
        id: 'view-mcp',
        title: 'Open MCP Servers',
        section: 'Navigation',
        keywords: ['tools', 'model context protocol'],
        run: goto('mcp'),
      },
      {
        id: 'view-automations',
        title: 'Open Monitors',
        section: 'Navigation',
        keywords: ['monitors', 'automations', 'agents', 'pipelines', 'watch'],
        run: goto('automations'),
      },
      {
        id: 'view-usage',
        title: 'Open Usage',
        section: 'Navigation',
        keywords: ['usage', 'credits', 'aic', 'cost', 'analytics', 'metasession', 'billing'],
        run: goto('usage'),
      },
      {
        id: 'view-agents',
        title: 'Open Agents',
        section: 'Navigation',
        keywords: ['agents', 'review board', 'analysis', 'attach'],
        run: goto('agents'),
      },
      {
        id: 'view-settings',
        title: 'Open Settings',
        section: 'Navigation',
        keywords: ['preferences', 'config'],
        run: goto('settings'),
      },
      {
        id: 'switch-cli',
        title: 'Choose active CLI',
        section: 'Navigation',
        keywords: ['provider', 'claude', 'copilot', 'agency'],
        shortcut: cliShortcutLabel(cliShortcut, navigator.platform),
        run: () => setCliOpen(true),
      },
      {
        id: 'toggle-theme',
        title: `Theme: ${themeModeLabel(mode)} (cycle)`,
        section: 'Appearance',
        keywords: ['dark', 'light', 'system', 'appearance', 'theme'],
        run: cycle,
      },
      {
        id: 'open-network-center',
        title: 'Open Network Activity Center',
        section: 'Help',
        keywords: ['network', 'egress', 'transparency', 'privacy', 'endpoints', 'data'],
        run: () => setNetworkOpen(true),
      },
      {
        id: 'toggle-sidebar',
        title: 'Toggle Sidebar',
        section: 'View',
        keywords: ['explorer', 'panel', 'hide', 'show'],
        shortcut: 'Ctrl+B',
        run: () => setSidebarOpen((prev) => !prev),
      },
      {
        id: 'toggle-dock',
        title: 'Toggle Icon Dock',
        section: 'View',
        keywords: ['activity bar', 'navigation', 'hide', 'show'],
        run: () => setDockVisible((prev) => !prev),
      },
      {
        id: 'show-shortcuts',
        title: 'Show Keyboard Shortcuts',
        section: 'Help',
        keywords: ['keys', 'bindings', 'hotkeys'],
        shortcut: 'Ctrl+/',
        run: () => setShortcutsOpen(true),
      },
    ];
  }, [mode, cycle, cliShortcut]);

  // Authoritative persisted stats, refreshed as live events arrive. The live
  // SSE feed alone is incomplete after reloads, so we never derive the status
  // bar figures from it directly.
  const ideUsage = useIdeUsage(liveSignal(live));
  const planUsage = usePlanUsage();
  const connection = useConnectionStatus();

  return (
    <MonitoringProvider live={live} navigationKey={JSON.stringify([view, monitoringOwnerKey])} onOpen={(tab) => {
      rememberMonitoringOrigin();
      setReopenTab((previous) => ({ tab, label: tab.label, nonce: (previous?.nonce ?? 0) + 1 }));
      setView('workspace');
    }} onCapacity={() => {
      rememberMonitoringOrigin();
      setCapacityRequest((previous) => (previous ?? 0) + 1);
      setView('settings');
    }}><div className="ide-shell">
      {clipboardError && <div className="clipboard-alert" role="alert">{clipboardError}</div>}
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      <ShortcutsSheet
        open={shortcutsOpen}
        bindings={shortcutBindings}
        onClose={() => setShortcutsOpen(false)}
      />
      <NetworkCenter open={networkOpen} onClose={() => setNetworkOpen(false)} />
      {cliOpen && <CliSelector onClose={() => setCliOpen(false)} />}
      <div className={`ide-main${dockVisible ? '' : ' is-dock-hidden'}`}>
        <nav id="icon-dock" className="activitybar" aria-label="Primary" hidden={!dockVisible}>
          <div className="activitybar-group">
            <Tooltip label="Command palette (Ctrl+K)">
            <button
              type="button"
              className="activitybar-brand"
              title="Command palette (Ctrl+K)"
              aria-label="Open command palette"
              onClick={() => setPaletteOpen(true)}
            >
              <BrandMark size={28} />
            </button>
            </Tooltip>
            <Tooltip label="Explorer (Ctrl+B)">
            <button
              type="button"
              className={`activity-item ${
                view === 'workspace' && sidebarOpen ? 'is-active' : ''
              }`.trim()}
              title="Explorer"
              aria-label="Explorer"
              aria-current={view === 'workspace' ? 'page' : undefined}
              aria-expanded={view === 'workspace' && sidebarOpen}
              onClick={() => {
                if (view === 'workspace') {
                  setSidebarOpen((v) => !v);
                } else {
                  setView('workspace');
                  setSidebarOpen(true);
                }
              }}
            >
              <FilesIcon size={22} />
            </button>
            </Tooltip>
            <Tooltip label="Planner">
            <button
              type="button"
              className={`activity-item ${view === 'planner' ? 'is-active' : ''}`.trim()}
              title="Planner"
              aria-label="Planner"
              aria-current={view === 'planner' ? 'page' : undefined}
              onClick={() => setView('planner')}
            >
              <PlannerIcon size={22} />
            </button>
            </Tooltip>
            <Tooltip label="Skills">
            <button
              type="button"
              className={`activity-item ${view === 'skills' ? 'is-active' : ''}`.trim()}
              title="Skills"
              aria-label="Skills"
              aria-current={view === 'skills' ? 'page' : undefined}
              onClick={() => setView('skills')}
            >
              <SkillsIcon size={22} />
            </button>
            </Tooltip>
            <Tooltip label="MCP Servers">
            <button
              type="button"
              className={`activity-item ${view === 'mcp' ? 'is-active' : ''}`.trim()}
              title="MCP Servers"
              aria-label="MCP Servers"
              aria-current={view === 'mcp' ? 'page' : undefined}
              onClick={() => setView('mcp')}
            >
              <McpIcon size={22} />
            </button>
            </Tooltip>
            <Tooltip label="Monitors">
            <button
              type="button"
              className={`activity-item ${
                view === 'automations' ? 'is-active' : ''
              }`.trim()}
              title="Monitors"
              aria-label="Monitors"
              aria-current={view === 'automations' ? 'page' : undefined}
              onClick={() => setView('automations')}
            >
              <AutomationIcon size={22} />
            </button>
            </Tooltip>
            <Tooltip label="Usage">
            <button
              type="button"
              className={`activity-item ${view === 'usage' ? 'is-active' : ''}`.trim()}
              title="Usage"
              aria-label="Usage"
              aria-current={view === 'usage' ? 'page' : undefined}
              onClick={() => setView('usage')}
            >
              <UsageIcon size={22} />
            </button>
            </Tooltip>
            <Tooltip label="Agents">
            <button
              type="button"
              className={`activity-item ${view === 'agents' ? 'is-active' : ''}`.trim()}
              title="Agents"
              aria-label="Agents"
              aria-current={view === 'agents' ? 'page' : undefined}
              onClick={() => setView('agents')}
            >
              <AiChatIcon size={22} />
            </button>
            </Tooltip>
            <Tooltip label="Settings">
            <button
              type="button"
              className={`activity-item ${view === 'settings' ? 'is-active' : ''}`.trim()}
              title="Settings"
              aria-label="Settings"
              aria-current={view === 'settings' ? 'page' : undefined}
              onClick={() => setView('settings')}
            >
              <SettingsIcon size={22} />
            </button>
            </Tooltip>
          </div>
          <div className="activitybar-group">
            <Tooltip label={`Choose active CLI (${cliShortcutLabel(cliShortcut, navigator.platform)})`}>
              <button type="button" className="activity-item" aria-label="Choose active CLI"
                title={`Choose active CLI — ${cliShortcutLabel(cliShortcut, navigator.platform)}`}
                onClick={() => setCliOpen(true)}>
                <SessionIcon size={20} />
              </button>
            </Tooltip>
            <Tooltip label={`Theme: ${themeModeLabel(mode)}; switch to ${theme === 'dark' ? 'light' : 'dark'}`}>
            <button
              type="button"
              className="activity-item"
              title={`Theme: ${themeModeLabel(mode)} — click to toggle`}
              aria-label={`Theme: ${themeModeLabel(mode)}`}
              onClick={toggle}
            >
              {theme === 'dark' ? <SunIcon size={20} /> : <MoonIcon size={20} />}
            </button>
            </Tooltip>
          </div>
        </nav>

        <div className="ide-content">
          <ConnectionBanner status={connection} liveInterrupted={live.streamInterrupted} liveHistoryLimited={live.liveCacheTruncated} />
          {monitoringOrigin && <div className="monitor-controls"><button type="button" className="ghost-button" onClick={() => {
            monitoringOrigin.restore?.();
            setView(monitoringOrigin.view);
            setMonitoringOrigin(null);
            setReopenTab(null);
            setCapacityRequest(undefined);
          }}>Return to monitoring</button></div>}
          <UpdateBanner />
          <OperationNoticeBanner />
          <FeatureDeletionStatus />
          {internalAgencyAvailable && <AgencyUpdatePopup />}
          {VIEW_ORDER.filter((id) => id === view || id === monitoringOrigin?.view).map((shownView) => <div className="view-transition" key={shownView} hidden={shownView !== view}>
            <Suspense fallback={shownView === 'workspace' ? <BrandedLoader title="Loading Explorer" /> : <ViewSkeleton label={view} />}>
              {shownView === 'workspace' ? (
                <WorkspaceView
                  providerSwitch={providerSwitch}
                  onMonitoringOrigin={captureMonitoringOrigin}
                  live={live}
                  sidebarOpen={sidebarOpen}
                  onToggleSidebar={() => setSidebarOpen((v) => !v)}
                  reopen={reopenTab}
                  launch={workspaceLaunch}
                  onLaunchConsumed={() => setWorkspaceLaunch(null)}
                />
              ) : shownView === 'planner' ? (
                <div className="settings-pane">
                  <PlannerView onLaunch={launchInWorkspace} />
                </div>
              ) : shownView === 'skills' ? (
                <div className="settings-pane">
                  <SkillsManager />
                </div>
              ) : shownView === 'mcp' ? (
                <div className="settings-pane">
                  <McpManager />
                </div>
              ) : shownView === 'automations' ? (
                <div className="settings-pane">
                  <AutomationsView live={live} />
                </div>
              ) : shownView === 'usage' ? (
                <div className="settings-pane">
                  <UsageView signal={liveSignal(live)} promptTarget={promptUsageTarget} />
                </div>
              ) : shownView === 'agents' ? (
                <div className="settings-pane">
                  <AgentsView />
                </div>
              ) : (
                <div className="settings-pane">
                  <SettingsView worktreesRequest={worktreesRequest} capacityRequest={capacityRequest} />
                </div>
              )}
            </Suspense>
          </div>)}
        </div>
      </div>

      <footer className="statusbar">
        <div className="statusbar-group">
          <button
            type="button"
            className="statusbar-item dock-toggle"
            title={dockVisible ? 'Hide icon dock' : 'Show icon dock'}
            aria-label={dockVisible ? 'Hide icon dock' : 'Show icon dock'}
            aria-expanded={dockVisible}
            aria-controls="icon-dock"
            onClick={() => setDockVisible((prev) => !prev)}
          >
            <CollapseSidebarIcon size={14} />
          </button>
          <span className="statusbar-item statusbar-accent">
            {view === 'workspace'
              ? 'Workspace'
              : view === 'planner'
                ? 'Planner'
                : view === 'skills'
                ? 'Skills'
                : view === 'mcp'
                  ? 'MCP Servers'
                  : view === 'automations'
                  ? 'Monitors'
                  : view === 'usage'
                    ? 'Usage'
                    : view === 'agents'
                      ? 'Agents'
                      : 'Settings'}
          </span>
          <ActiveSessionsStatus api={api} live={live} onOpen={openActiveSession} />
          <ActivityStatus />
        </div>
        <div className="statusbar-group">
          <ResourceStatus connection={connection} onManageWorktrees={() => {
            setWorktreesRequest((value) => (value ?? 0) + 1);
            setView('settings');
          }} />
          <MetaModelStatus />
          <PlanUsageIndicator state={planUsage} />
          <span
            className="statusbar-item statusbar-ide"
            title="IDE AI overhead — AIC spent by the assistant's own meta sessions (summaries, task plans). Separate from feature dev cost."
          >
            <SkillsIcon size={12} /> {formatAic(ideUsage?.totals.nanoAiu ?? 0)} IDE AI
          </span>
          <span className="statusbar-item" title={`Theme: ${themeModeLabel(mode)}`}>
            {themeModeLabel(mode)}
          </span>
        </div>
      </footer>
    </div></MonitoringProvider>
  );
}
