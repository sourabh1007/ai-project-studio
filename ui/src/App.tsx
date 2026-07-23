import { useState } from 'react';
import { useUsageStream } from './hooks/use-usage-stream.js';
import { useTheme } from './hooks/use-theme.js';
import { useWorkspaceStats } from './hooks/use-workspace-stats.js';
import { liveSignal } from './lib/stream.js';
import { formatAic, formatCompactNumber } from './lib/format.js';
import { WorkspaceView } from './features/workspace/workspace-view.js';
import { SettingsView } from './features/settings/settings-view.js';
import {
  FilesIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
} from './components/icons.js';

type View = 'workspace' | 'settings';

export function App() {
  const live = useUsageStream();
  const { theme, toggle } = useTheme();
  const [view, setView] = useState<View>('workspace');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Authoritative persisted stats, refreshed as live events arrive. The live
  // SSE feed alone is incomplete after reloads, so we never derive the status
  // bar figures from it directly.
  const stats = useWorkspaceStats(liveSignal(live));
  const totals = stats?.totals ?? null;
  const activeSessions = stats?.activeSessions ?? 0;

  return (
    <div className="ide-shell">
      <div className="ide-main">
        <nav className="activitybar" aria-label="Primary">
          <div className="activitybar-group">
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
              title={
                theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
              }
              aria-label="Toggle theme"
              onClick={toggle}
            >
              {theme === 'dark' ? <SunIcon size={20} /> : <MoonIcon size={20} />}
            </button>
          </div>
        </nav>

        <div className="ide-content">
          {view === 'workspace' ? (
            <WorkspaceView
              live={live}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen((v) => !v)}
            />
          ) : (
            <div className="settings-pane">
              <SettingsView />
            </div>
          )}
        </div>
      </div>

      <footer className="statusbar">
        <div className="statusbar-group">
          <span className="statusbar-item statusbar-accent">
            {view === 'workspace' ? 'Workspace' : 'Settings'}
          </span>
          <span className="statusbar-item">{activeSessions} active</span>
        </div>
        <div className="statusbar-group">
          <span className="statusbar-item" title="AIC used (github nano_aiu)">
            ◆ {formatAic(totals?.nanoAiu ?? 0)} AIC
          </span>
          <span className="statusbar-item" title="Input tokens">
            ↑ {formatCompactNumber(totals?.inputTokens ?? 0)}
          </span>
          <span className="statusbar-item" title="Output tokens">
            ↓ {formatCompactNumber(totals?.outputTokens ?? 0)}
          </span>
          <span className="statusbar-item">
            {theme === 'dark' ? 'Dark' : 'Light'}
          </span>
        </div>
      </footer>
    </div>
  );
}
