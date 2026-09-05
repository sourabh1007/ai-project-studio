import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useUsageStream } from './hooks/use-usage-stream.js';
import { useTheme } from './hooks/use-theme.js';
import { useGlobalClipboard } from './hooks/use-global-clipboard.js';
import { themeModeLabel } from './lib/theme.js';
import { useWorkspaceStats } from './hooks/use-workspace-stats.js';
import { useIdeUsage } from './hooks/use-ide-usage.js';
import { usePlanUsage } from './hooks/use-plan-usage.js';
import { useActivity } from './hooks/use-activity.js';
import { liveSignal } from './lib/stream.js';
import { formatAic } from './lib/format.js';
import { TopLoadingBar } from './components/top-loading-bar.js';
import { ConnectionBanner } from './components/connection-banner.js';
import { UpdateBanner } from './features/updates/update-banner.js';
import { ViewSkeleton } from './components/view-skeleton.js';

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
import {
  CommandPalette,
  type PaletteCommand,
} from './components/command-palette.js';
import { ShortcutsSheet } from './components/shortcuts-sheet.js';
import { NetworkCenter } from './features/network-center/network-center.js';
import { MetaModelStatus } from './features/status-bar/meta-model-status.js';
import { PlanUsageIndicator } from './components/plan-usage-indicator.js';
import {
  matchShortcut,
  type ShortcutBinding,
} from './lib/keyboard-shortcuts.js';
import { usePersistentState } from './hooks/use-persistent-state.js';
import { isOneOf } from './lib/persisted-state.js';
import {
  AutomationIcon,
  FilesIcon,
  McpIcon,
  MoonIcon,
  SettingsIcon,
  SkillsIcon,
  SunIcon,
} from './components/icons.js';

type View = 'workspace' | 'skills' | 'mcp' | 'automations' | 'settings';

/** View cycle order for Ctrl+Tab / Ctrl+Shift+Tab. */
const VIEW_ORDER: View[] = ['workspace', 'skills', 'mcp', 'automations', 'settings'];

/** The global keyboard shortcuts, shown in the discoverable shortcuts sheet. */
const SHORTCUT_BINDINGS: ShortcutBinding[] = [
  { id: 'palette', title: 'Open command palette', key: 'k', ctrlOrMeta: true },
  { id: 'palette', title: 'Quick open', key: 'p', ctrlOrMeta: true },
  { id: 'next-view', title: 'Next view', key: 'Tab', ctrlOrMeta: true },
  { id: 'prev-view', title: 'Previous view', key: 'Tab', ctrlOrMeta: true, shift: true },
  { id: 'toggle-sidebar', title: 'Toggle sidebar', key: 'b', ctrlOrMeta: true },
  { id: 'open-settings', title: 'Open settings', key: ',', ctrlOrMeta: true },
  { id: 'show-shortcuts', title: 'Show keyboard shortcuts', key: '/', ctrlOrMeta: true },
];

export function App() {
  const live = useUsageStream();
  const { mode, theme, cycle } = useTheme();
  const [view, setView] = usePersistentState<View>('cw-active-view', 'workspace', {
    validate: isOneOf(VIEW_ORDER),
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);

  // App-wide clipboard hardening so Ctrl/Cmd+C on any selected UI text reaches
  // the OS clipboard (the app's non-secure localhost origin disables the web
  // Clipboard API). See use-global-clipboard.
  useGlobalClipboard();

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
      const binding = matchShortcut(event, SHORTCUT_BINDINGS);
      if (!binding) return;
      event.preventDefault();
      switch (binding.id) {
        case 'palette':
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
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const commands = useMemo<PaletteCommand[]>(() => {
    const goto = (next: View) => () => {
      setView(next);
      if (next === 'workspace') {
        setSidebarOpen(true);
      }
    };
    return [
      {
        id: 'view-workspace',
        title: 'Open Explorer',
        section: 'Navigation',
        keywords: ['workspace', 'files', 'sessions'],
        run: goto('workspace'),
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
        id: 'view-settings',
        title: 'Open Settings',
        section: 'Navigation',
        keywords: ['preferences', 'config'],
        run: goto('settings'),
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
        id: 'show-shortcuts',
        title: 'Show Keyboard Shortcuts',
        section: 'Help',
        keywords: ['keys', 'bindings', 'hotkeys'],
        shortcut: 'Ctrl+/',
        run: () => setShortcutsOpen(true),
      },
    ];
  }, [mode, cycle]);

  // Authoritative persisted stats, refreshed as live events arrive. The live
  // SSE feed alone is incomplete after reloads, so we never derive the status
  // bar figures from it directly.
  const stats = useWorkspaceStats(liveSignal(live));
  const activeSessions = stats?.activeSessions ?? 0;
  const ideUsage = useIdeUsage(liveSignal(live));
  const planUsage = usePlanUsage();
  const activity = useActivity();

  return (
    <div className="ide-shell">
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      <ShortcutsSheet
        open={shortcutsOpen}
        bindings={SHORTCUT_BINDINGS}
        onClose={() => setShortcutsOpen(false)}
      />
      <NetworkCenter open={networkOpen} onClose={() => setNetworkOpen(false)} />
      <div className="ide-main">
        <nav className="activitybar" aria-label="Primary">
          <div className="activitybar-group">
            <button
              type="button"
              className="activitybar-brand"
              title="Command palette (Ctrl+K)"
              aria-label="Open command palette"
              onClick={() => setPaletteOpen(true)}
            >
              <img
                src="/logo.png"
                alt="AI Project Studio"
                width={30}
                height={30}
              />
            </button>
            <button
              type="button"
              className={`activity-item ${
                view === 'workspace' && sidebarOpen ? 'is-active' : ''
              }`.trim()}
              title="Explorer"
              aria-label="Explorer"
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
            <button
              type="button"
              className={`activity-item ${view === 'skills' ? 'is-active' : ''}`.trim()}
              title="Skills"
              aria-label="Skills"
              onClick={() => setView('skills')}
            >
              <SkillsIcon size={22} />
            </button>
            <button
              type="button"
              className={`activity-item ${view === 'mcp' ? 'is-active' : ''}`.trim()}
              title="MCP Servers"
              aria-label="MCP Servers"
              onClick={() => setView('mcp')}
            >
              <McpIcon size={22} />
            </button>
            <button
              type="button"
              className={`activity-item ${
                view === 'automations' ? 'is-active' : ''
              }`.trim()}
              title="Monitors"
              aria-label="Monitors"
              onClick={() => setView('automations')}
            >
              <AutomationIcon size={22} />
            </button>
            <button
              type="button"
              className={`activity-item ${view === 'settings' ? 'is-active' : ''}`.trim()}
              title="Settings"
              aria-label="Settings"
              onClick={() => setView('settings')}
            >
              <SettingsIcon size={22} />
            </button>
          </div>
          <div className="activitybar-group">
            <button
              type="button"
              className="activity-item"
              title={`Theme: ${themeModeLabel(mode)} — click to cycle`}
              aria-label={`Theme: ${themeModeLabel(mode)}`}
              onClick={cycle}
            >
              {theme === 'dark' ? <SunIcon size={20} /> : <MoonIcon size={20} />}
            </button>
          </div>
        </nav>

        <div className="ide-content">
          <TopLoadingBar />
          <ConnectionBanner />
          <UpdateBanner />
          <div className="view-transition" key={view}>
            <Suspense fallback={<ViewSkeleton label={view} />}>
              {view === 'workspace' ? (
                <WorkspaceView
                  live={live}
                  sidebarOpen={sidebarOpen}
                  onToggleSidebar={() => setSidebarOpen((v) => !v)}
                />
              ) : view === 'skills' ? (
                <div className="settings-pane">
                  <SkillsManager />
                </div>
              ) : view === 'mcp' ? (
                <div className="settings-pane">
                  <McpManager />
                </div>
              ) : view === 'automations' ? (
                <div className="settings-pane">
                  <AutomationsView live={live} />
                </div>
              ) : (
                <div className="settings-pane">
                  <SettingsView />
                </div>
              )}
            </Suspense>
          </div>
        </div>
      </div>

      <footer className="statusbar">
        <div className="statusbar-group">
          <span className="statusbar-item statusbar-accent">
            {view === 'workspace'
              ? 'Workspace'
              : view === 'skills'
                ? 'Skills'
                : view === 'mcp'
                  ? 'MCP Servers'
                  : view === 'automations'
                  ? 'Monitors'
                    : 'Settings'}
          </span>
          <span className="statusbar-item">{activeSessions} active</span>
          <span
            className={`statusbar-activity ${
              activity.error
                ? 'is-error'
                : activity.pending > 0
                  ? 'is-busy'
                  : 'is-idle'
            }`}
            title={
              activity.error ?? (activity.pending > 0 ? activity.label ?? '' : 'Ready')
            }
            aria-live="polite"
          >
            {activity.error ? (
              <span className="statusbar-activity-dot" aria-hidden="true" />
            ) : activity.pending > 0 ? (
              <span className="spinner statusbar-spinner" aria-hidden="true" />
            ) : (
              <span className="statusbar-activity-dot" aria-hidden="true" />
            )}
            <span className="statusbar-activity-label">
              {activity.error ?? (activity.pending > 0 ? activity.label : 'Ready')}
            </span>
          </span>
        </div>
        <div className="statusbar-group">
          <MetaModelStatus />
          <PlanUsageIndicator usage={planUsage} />
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
    </div>
  );
}
