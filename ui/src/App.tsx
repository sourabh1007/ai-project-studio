import { useState } from 'react';
import { useUsageStream } from './hooks/use-usage-stream.js';
import { useTheme } from './hooks/use-theme.js';
import { useWorkspaceStats } from './hooks/use-workspace-stats.js';
import { liveSignal } from './lib/stream.js';
import { formatAic, formatCompactNumber } from './lib/format.js';
import { WorkspaceView } from './features/workspace/workspace-view.js';
import { SettingsView } from './features/settings/settings-view.js';

type View = 'workspace' | 'settings';

function FilesIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        d="M4 4h8l2 3h6v13H4z"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9L19 19M19 5l-2.1 2.1M7.1 16.9L5 19"
      />
    </svg>
  );
}

function ThemeIcon({ dark }: { dark: boolean }) {
  return dark ? (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" fill="currentColor" />
      <path
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.5 4.5l1.8 1.8M17.7 17.7l1.8 1.8M19.5 4.5l-1.8 1.8M6.3 17.7l-1.8 1.8"
      />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"
      />
    </svg>
  );
}

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
              <FilesIcon />
            </button>
            <button
              type="button"
              className={`activity-item ${view === 'settings' ? 'is-active' : ''}`.trim()}
              title="Settings"
              aria-label="Settings"
              onClick={() => setView('settings')}
            >
              <GearIcon />
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
              <ThemeIcon dark={theme === 'dark'} />
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
