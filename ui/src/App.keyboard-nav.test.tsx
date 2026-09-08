import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from './app/api-context.js';
import { App } from './App.js';
import type { ApiClient } from './lib/api.js';

const h = vi.hoisted(() => ({
  terminalKeyDown: vi.fn(),
}));

vi.mock('./hooks/use-usage-stream.js', () => ({
  useUsageStream: () => ({
    sessions: {},
    usageByKey: {},
    repositoryContexts: {},
    prReviews: {},
    contextStatus: {},
    automations: {},
    subagents: {},
    reviewBoardActivity: {},
    fileChangesBySession: {},
  }),
}));
vi.mock('./hooks/use-theme.js', () => ({
  useTheme: () => ({ mode: 'dark', theme: 'dark', cycle: () => {} }),
}));
vi.mock('./hooks/use-global-clipboard.js', () => ({
  useGlobalClipboard: () => null,
}));
vi.mock('./hooks/use-workspace-stats.js', () => ({
  useWorkspaceStats: () => ({ activeSessions: 0 }),
}));
vi.mock('./hooks/use-ide-usage.js', () => ({
  useIdeUsage: () => ({ totals: { nanoAiu: 0 } }),
}));
vi.mock('./hooks/use-plan-usage.js', () => ({
  usePlanUsage: () => null,
}));
vi.mock('./hooks/use-activity.js', () => ({
  useActivity: () => ({ pending: 0, error: null, label: null }),
}));
vi.mock('./hooks/use-ui-preferences.js', () => ({
  useApplyUiPreferences: () => undefined,
}));
vi.mock('./components/command-palette.js', () => ({
  CommandPalette: ({
    open,
    onClose,
  }: {
    open: boolean;
    onClose: () => void;
  }) =>
    open ? (
      <div role="dialog" aria-modal="true" aria-label="Command palette">
        <input aria-label="Command palette search" />
        <button type="button" onClick={onClose}>Close palette</button>
      </div>
    ) : null,
}));
vi.mock('./components/shortcuts-sheet.js', () => ({
  ShortcutsSheet: () => null,
}));
vi.mock('./features/network-center/network-center.js', () => ({
  NetworkCenter: () => null,
}));
vi.mock('./features/status-bar/meta-model-status.js', () => ({
  MetaModelStatus: () => null,
}));
vi.mock('./components/plan-usage-indicator.js', () => ({
  PlanUsageIndicator: () => null,
}));
vi.mock('./components/top-loading-bar.js', () => ({
  TopLoadingBar: () => null,
}));
vi.mock('./components/connection-banner.js', () => ({
  ConnectionBanner: () => null,
}));
vi.mock('./features/updates/update-banner.js', () => ({
  UpdateBanner: () => null,
}));
vi.mock('./components/view-skeleton.js', () => ({
  ViewSkeleton: () => <div>Loading…</div>,
}));
vi.mock('./features/settings/settings-view.js', () => ({
  SettingsView: () => <div>Settings panel</div>,
}));
vi.mock('./features/skills/skills-manager.js', () => ({
  SkillsManager: () => <div>Skills panel</div>,
}));
vi.mock('./features/mcp/mcp-manager.js', () => ({
  McpManager: () => <div>MCP panel</div>,
}));
vi.mock('./features/automations/automations-view.js', () => ({
  AutomationsView: () => <div>Monitors panel</div>,
}));
vi.mock('./features/workspace/workspace-view.js', () => ({
  WorkspaceView: () => (
    <div>
      <input
        aria-label="Terminal shell"
        onKeyDown={(event) => h.terminalKeyDown(event.key)}
      />
    </div>
  ),
}));

function apiClient(): ApiClient {
  return {
    listFeatures: vi.fn().mockResolvedValue([]),
    listRepos: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockResolvedValue([]),
  } as unknown as ApiClient;
}

function renderApp(client = apiClient()) {
  return render(
    <ApiProvider value={client}>
      <App />
    </ApiProvider>,
  );
}

describe('App keyboard ownership and navigation semantics', () => {
  beforeEach(() => {
    h.terminalKeyDown.mockReset();
    window.localStorage.clear();
  });

  it('handles app-owned shortcuts before terminal inputs and leaves Ctrl+C alone', async () => {
    renderApp();
    const shell = await screen.findByRole('textbox', { name: 'Terminal shell' });
    shell.focus();

    fireEvent.keyDown(shell, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(h.terminalKeyDown).not.toHaveBeenCalled();

    fireEvent.keyDown(shell, { key: 'c', ctrlKey: true });
    expect(h.terminalKeyDown).toHaveBeenCalledWith('c');
  });

  it('lets an open dialog own the keyboard so app shortcuts do not toggle underneath it', async () => {
    renderApp();
    const shell = await screen.findByRole('textbox', { name: 'Terminal shell' });
    fireEvent.keyDown(shell, { key: 'k', ctrlKey: true });

    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    const search = screen.getByRole('textbox', { name: 'Command palette search' });
    fireEvent.keyDown(search, { key: 'p', ctrlKey: true });

    expect(palette).toBeInTheDocument();
  });

  it('announces the current view and explorer expansion state', async () => {
    renderApp();

    const explorer = screen.getByRole('button', { name: 'Explorer' });
    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(explorer).toHaveAttribute('aria-current', 'page');
    expect(explorer).toHaveAttribute('aria-expanded', 'true');
    expect(settings).not.toHaveAttribute('aria-current');

    fireEvent.click(settings);
    expect(await screen.findByText('Settings panel')).toBeInTheDocument();
    expect(settings).toHaveAttribute('aria-current', 'page');
    expect(explorer).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(explorer);
    expect(await screen.findByRole('textbox', { name: 'Terminal shell' })).toBeInTheDocument();
    expect(explorer).toHaveAttribute('aria-current', 'page');
    expect(explorer).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(explorer);
    expect(explorer).toHaveAttribute('aria-expanded', 'false');
  });
});
