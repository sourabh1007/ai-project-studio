import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../app/api-context.js';
import { App } from '../App.js';
import type { ApiClient } from '../lib/api.js';

vi.mock('../hooks/use-usage-stream.js', () => ({
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
vi.mock('../hooks/use-theme.js', () => ({
  useTheme: () => ({ mode: 'dark', theme: 'dark', cycle: vi.fn() }),
}));
vi.mock('../hooks/use-global-clipboard.js', () => ({
  useGlobalClipboard: () => null,
}));
vi.mock('../hooks/use-workspace-stats.js', () => ({
  useWorkspaceStats: () => ({ activeSessions: 0 }),
}));
vi.mock('../hooks/use-ide-usage.js', () => ({
  useIdeUsage: () => ({ totals: { nanoAiu: 0 } }),
}));
vi.mock('../hooks/use-plan-usage.js', () => ({
  usePlanUsage: () => ({ status: 'ready', usage: null, error: null }),
}));
vi.mock('../hooks/use-activity.js', () => ({
  useActivity: () => ({ pending: 0, error: null, label: null }),
}));
vi.mock('../hooks/use-ui-preferences.js', () => ({
  useApplyUiPreferences: () => undefined,
}));
vi.mock('../components/top-loading-bar.js', () => ({
  TopLoadingBar: () => null,
}));
vi.mock('../components/connection-banner.js', () => ({
  ConnectionBanner: () => null,
}));
vi.mock('../features/updates/update-banner.js', () => ({
  UpdateBanner: () => null,
}));
vi.mock('../features/network-center/network-center.js', () => ({
  NetworkCenter: () => null,
}));
vi.mock('../features/status-bar/meta-model-status.js', () => ({
  MetaModelStatus: () => null,
}));
vi.mock('../components/plan-usage-indicator.js', () => ({
  PlanUsageIndicator: () => null,
}));
vi.mock('../components/view-skeleton.js', () => ({
  ViewSkeleton: ({ label }: { label: string }) => <div>Loading {label}</div>,
}));
vi.mock('../features/workspace/workspace-view.js', () => ({
  WorkspaceView: () => <div>Workspace destination</div>,
}));
vi.mock('../features/settings/settings-view.js', () => ({
  SettingsView: () => <div>Settings destination</div>,
}));
vi.mock('../features/skills/skills-manager.js', () => ({
  SkillsManager: () => <div>Skills destination</div>,
}));
vi.mock('../features/mcp/mcp-manager.js', () => ({
  McpManager: () => <div>MCP destination</div>,
}));
vi.mock('../features/automations/automations-view.js', () => ({
  AutomationsView: () => <div>Monitors destination</div>,
}));

function api(): ApiClient {
  return {} as ApiClient;
}

function renderApp() {
  return render(
    <ApiProvider value={api()}>
      <App />
    </ApiProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  }
});

describe('App navigation journeys', () => {
  it('uses quick-open and palette commands to navigate, toggles the sidebar, and exposes shortcuts', async () => {
    renderApp();
    expect(await screen.findByText('Workspace destination')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Explorer' })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Explorer' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    const search = screen.getByRole('textbox', { name: 'Command palette search' });
    fireEvent.change(search, { target: { value: 'skills' } });
    expect(within(palette).getByRole('option', { name: /Open Skills/ })).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(await screen.findByText('Skills destination')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const commandPalette = await screen.findByRole('dialog', { name: 'Command palette' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Command palette search' }), {
      target: { value: 'settings' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Command palette search' }), {
      key: 'Enter',
    });
    expect(commandPalette).not.toBeInTheDocument();
    expect(await screen.findByText('Settings destination')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: '/', ctrlKey: true });
    const shortcuts = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(shortcuts).toHaveTextContent('Open command palette');
    expect(shortcuts).toHaveTextContent('Quick open');
    expect(shortcuts).toHaveTextContent('Toggle sidebar');
    fireEvent.keyDown(shortcuts, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull());
  });
});
