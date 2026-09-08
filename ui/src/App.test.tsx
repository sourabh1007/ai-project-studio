import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from './app/api-context.js';
import { App } from './App.js';
import type { ApiClient } from './lib/api.js';
import type { Feature, Repository, Session } from './lib/types.js';

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
  CommandPalette: () => null,
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
vi.mock('./features/workspace/explorer.js', () => ({
  Explorer: (props: {
    onOpenSession: (session: Session, label: string) => void;
    onOpenFeature: (feature: Feature) => void;
    onOpenRepo: (repo: Repository) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          props.onOpenSession(
            {
              id: 's1',
              featureId: 'f1',
              name: null,
              provider: 'copilot',
              requestedModel: 'gpt-5.5',
              resolvedModel: null,
              status: 'created',
              kind: 'dev',
              prompt: 'prompt',
              usageFilePath: 'C:\\usage.json',
              createdAt: '2026-01-01T00:00:00.000Z',
              startedAt: null,
              endedAt: null,
              exitCode: null,
              groupId: null,
              orderIndex: 0,
            },
            'Session 1',
          )
        }
      >
        Open session tab
      </button>
      <button
        type="button"
        onClick={() =>
          props.onOpenFeature({
            id: 'f1',
            name: 'Feature 1',
            description: 'desc',
            createdAt: '2026-01-01T00:00:00.000Z',
            summary: null,
            repoId: 'r1',
            checkoutPath: null,
            parentFeatureId: null,
            orderIndex: 0,
          })
        }
      >
        Open feature tab
      </button>
      <button
        type="button"
        onClick={() =>
          props.onOpenRepo({
            id: 'r1',
            provider: 'github',
            remoteUrl: 'https://github.com/acme/app',
            name: 'acme/app',
            localPath: 'C:\\repo',
            defaultBranch: 'main',
            createdAt: '2026-01-01T00:00:00.000Z',
          })
        }
      >
        Open repo tab
      </button>
    </div>
  ),
}));
vi.mock('./components/terminal-view.js', () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => (
    <div>Terminal {sessionId}</div>
  ),
}));
vi.mock('./features/feature-dashboard/feature-dashboard.js', () => ({
  FeatureDashboard: ({ featureName }: { featureName: string }) => (
    <div>Feature {featureName}</div>
  ),
}));
vi.mock('./features/review-board-page/review-board-page.js', () => ({
  ReviewBoardPage: ({ featureId }: { featureId: string }) => (
    <div>Review board {featureId}</div>
  ),
}));
vi.mock('./features/repo-dashboard/repo-dashboard.js', () => ({
  RepoDashboard: ({ repo }: { repo: Repository }) => <div>Repo {repo.name}</div>,
}));

function apiClient(): ApiClient {
  return {
    listFeatures: vi.fn().mockResolvedValue([
      {
        id: 'f1',
        name: 'Feature 1',
        description: 'desc',
        createdAt: '2026-01-01T00:00:00.000Z',
        summary: null,
        repoId: 'r1',
        checkoutPath: null,
        parentFeatureId: null,
        orderIndex: 0,
      },
    ]),
    listRepos: vi.fn().mockResolvedValue([
      {
        id: 'r1',
        provider: 'github',
        remoteUrl: 'https://github.com/acme/app',
        name: 'acme/app',
        localPath: 'C:\\repo',
        defaultBranch: 'main',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
    listSessions: vi.fn().mockResolvedValue([
      {
        id: 's1',
        featureId: 'f1',
        name: null,
        provider: 'copilot',
        requestedModel: 'gpt-5.5',
        resolvedModel: null,
        status: 'created',
        kind: 'dev',
        prompt: 'prompt',
        usageFilePath: 'C:\\usage.json',
        createdAt: '2026-01-01T00:00:00.000Z',
        startedAt: null,
        endedAt: null,
        exitCode: null,
        groupId: null,
        orderIndex: 0,
      },
    ]),
  } as unknown as ApiClient;
}

function renderApp(client = apiClient()) {
  return render(
    <ApiProvider value={client}>
      <App />
    </ApiProvider>,
  );
}

describe('App workspace tab persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('keeps open tabs and the active tab across top-level navigation', async () => {
    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open session tab' }));
    expect(await screen.findByText('Terminal s1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open repo tab' }));
    expect(await screen.findByText('Repo acme/app')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByText('Settings panel')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Explorer' }));
    expect(await screen.findByText('Repo acme/app')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Session 1/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /acme\/app/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'MCP Servers' }));
    expect(await screen.findByText('MCP panel')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Explorer' }));
    expect(await screen.findByText('Repo acme/app')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Monitors' }));
    expect(await screen.findByText('Monitors panel')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Explorer' }));
    expect(await screen.findByText('Repo acme/app')).toBeInTheDocument();
  });

  it('restores persisted tabs after restart and preserves explicit closures', async () => {
    const first = renderApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Open session tab' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open feature tab' }));
    expect(await screen.findByText('Feature Feature 1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close Session 1' }));
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: /Session 1/ })).not.toBeInTheDocument(),
    );
    first.unmount();

    renderApp();
    expect(await screen.findByText('Feature Feature 1')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Session 1/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Feature 1/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
