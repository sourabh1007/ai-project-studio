import { fireEvent, render, screen, waitFor, within, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../app/api-context.js';
import { SettingsView } from '../features/settings/settings-view.js';
import type { ApiClient } from '../lib/api.js';
import { clearFailures, recordFailure } from '../lib/failure-log.js';
import type {
  ConfigResponse,
  ManagedWorktree,
} from '../lib/types.js';

function config(): ConfigResponse {
  return {
    namespaces: ['logging', 'meta'],
    defaults: {
      logging: { directory: 'C:\\logs', level: 'info' },
      meta: { warmPool: { enabled: false, size: 1 } },
    },
    schema: {},
    current: {
      logging: { directory: 'C:\\logs', level: 'info' },
      meta: { warmPool: { enabled: false, size: 1 } },
    },
    overrides: { logging: {}, meta: {} },
  };
}

function worktree(path = 'C:\\repo\\.ai-worktrees\\review-42'): ManagedWorktree {
  return {
    path,
    branch: 'review/42',
    repoId: 'repo-1',
    repoName: 'acme/app',
    pullNumber: 42,
  };
}

function apiFor(
  worktrees: ManagedWorktree[],
  overrides: Partial<ApiClient> = {},
): ApiClient {
  let activeProvider = 'copilot';
  const bootstrap = () => ({
    defaultProvider: activeProvider,
    selectionRequired: false,
    microsoftSignedIn: true,
    providers: [
      { id: 'copilot', installed: true },
      { id: 'claude', installed: true },
    ],
  });
  return {
    getConfig: vi.fn().mockResolvedValue(config()),
    getCommandCatalog: vi.fn().mockResolvedValue([]),
    getVersion: vi.fn().mockResolvedValue('0.11.5'),
    getAgencyStatus: vi.fn().mockResolvedValue({ installed: false }),
    getProviderBootstrap: vi.fn().mockImplementation(async () => bootstrap()),
    selectProvider: vi.fn().mockImplementation(async (providerId: string) => {
      activeProvider = providerId;
      return bootstrap();
    }),
    switchProvider: vi.fn().mockImplementation(async ({ providerId }: { providerId: string }) => {
      activeProvider = providerId;
      return bootstrap();
    }),
    checkHealth: vi.fn().mockResolvedValue({ status: 'ok', uptimeMs: 12 }),
    listWorktrees: vi.fn().mockImplementation(async () => [...worktrees]),
    removeWorktree: vi.fn().mockImplementation(async (path: string) => {
      const index = worktrees.findIndex((entry) => entry.path === path);
      if (index >= 0) worktrees.splice(index, 1);
      return { removed: true };
    }),
    ...overrides,
  } as unknown as ApiClient;
}

function renderSettings(api: ApiClient) {
  return render(
    <ApiProvider value={api}>
      <SettingsView />
    </ApiProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  clearFailures();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('dark'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

afterEach(() => {
  cleanup();
  clearFailures();
  delete (window as unknown as { desktop?: unknown }).desktop;
});

describe('Settings renderer journeys', () => {
  it('restores the compact live metasession dashboard before secondary model settings', async () => {
    const sessions = Array.from({ length: 12 }, (_, index) => ({
      id: `s${index + 1}`, state: 'idle', served: index < 6 ? 1 : 0,
      startedAt: 1000, lastActiveAt: null, inputTokens: 0, outputTokens: 0, history: [],
    }));
    const current = config();
    current.current.meta = { warmPool: { enabled: true, size: 15 } };
    const updateConfig = vi.fn();
    const resizeMetaPool = vi.fn();
    const api = apiFor([], {
      getConfig: vi.fn().mockResolvedValue(current),
      getMetaPools: vi.fn().mockResolvedValue({
        enabled: true, model: 'auto',
        processAdmission: { processes: 13, warmProcesses: 12, queued: 0, closed: false,
          maxProcesses: 16, maxWarmProcesses: 12, maxQueued: 32 },
        pool: { size: 15, suggestedSize: 1, live: 12, idle: 12, busy: 0,
          ready: true, served: 6, waitingForCapacity: true, sessions },
      }),
      getMetaSettings: vi.fn().mockResolvedValue({ providerId: 'copilot', model: 'auto', warmPoolEnabled: true }),
      getMetaModels: vi.fn().mockResolvedValue([{ id: 'auto', name: 'Auto', enabled: true }]),
      listMetaOperations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      updateConfig, resizeMetaPool,
    });
    renderSettings(api);
    fireEvent.click(await screen.findByRole('tab', { name: 'Metasession' }));
    expect(await screen.findByRole('checkbox', { name: 'Keep metasessions warm' })).toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'Parallel metasessions' })).toHaveValue(15);
    expect(screen.getByText('Ready')).toBeVisible();
    expect(screen.getByText(/Headless process budget:/)).toHaveTextContent('13/16 processes, 12/12 warm; queue 0/32');
    expect(screen.getByText(/Waiting for shared process capacity —/)).toHaveTextContent('12 of 15 ready, 0 warming');
    expect(await screen.findByLabelText('Metasession s1: Idle, 1 turns. View details')).toBeVisible();
    expect(screen.getAllByLabelText(/Metasession slot .*Waiting for shared process capacity/)).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeVisible();
    const modelSettings = screen.getByText('Provider and model', { selector: 'summary' }).closest('details')!;
    expect(modelSettings).not.toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Save changes' })
      .compareDocumentPosition(modelSettings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Metasession s1: Idle, 1 turns. View details'));
    const dialog = screen.getByRole('dialog', { name: 'Metasession s1' });
    expect(dialog).toHaveTextContent('Ready for a command');
    expect(dialog).toHaveTextContent('Turns served');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByText('Provider and model', { selector: 'summary' }));
    expect(modelSettings).toHaveAttribute('open');
    expect(await screen.findByRole('combobox', { name: 'Model' })).toBeVisible();
    expect(updateConfig).not.toHaveBeenCalled();
    expect(resizeMetaPool).not.toHaveBeenCalled();
  });

  it('navigates through real settings sections and persists appearance across remount', async () => {
    const retainedList = vi.fn().mockResolvedValue({
      status: 'ready',
      items: [],
      totalBytes: 0,
      limits: { files: 64, totalBytes: 64 * 1024 * 1024, fileBytes: 8 * 1024 * 1024 },
    });
    const worktrees = [worktree()];
    const api = apiFor(worktrees);
    (window as unknown as { desktop: unknown }).desktop = {
      getVersion: vi.fn().mockResolvedValue('0.11.5'),
      attachments: {
        list: retainedList,
        remove: vi.fn().mockResolvedValue({ status: 'cancelled' }),
      },
    };

    const first = renderSettings(api);
    expect(await screen.findByText('Software updates')).toBeInTheDocument();
    expect(screen.queryByText('Agency CLI')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Tools & CLIs' }));
    const cli = within(await screen.findByRole('region', { name: 'CLI selection' }));
    await waitFor(() => expect(cli.getByText('Active CLI:')).toHaveTextContent('Active CLI: Copilot'));
    expect(cli.getByRole('button', { name: 'Copilot settings' })).toHaveAttribute('aria-expanded', 'false');
    expect(cli.queryByRole('button', { name: 'Use Copilot' })).not.toBeInTheDocument();
    fireEvent.click(cli.getByRole('button', { name: 'Copilot settings' }));
    fireEvent.click(cli.getByRole('button', { name: 'Claude Code settings' }));
    expect(cli.getByRole('button', { name: 'Use Copilot' })).toBeEnabled();
    expect(cli.getByRole('button', { name: 'Use Claude Code' })).toBeEnabled();
    expect(cli.queryByRole('button', { name: 'Use Agency' })).not.toBeInTheDocument();
    expect(api.selectProvider).not.toHaveBeenCalled();
    fireEvent.click(cli.getByRole('button', { name: 'Use Claude Code' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop CLI work and switch' }));
    await waitFor(() => expect(cli.getByText('Active CLI:')).toHaveTextContent('Active CLI: Claude Code'));
    expect(api.switchProvider).toHaveBeenCalledTimes(1);
    expect(api.switchProvider).toHaveBeenCalledWith({ providerId: 'claude', remember: true, expectedRevision: 0 });
    expect(cli.getByRole('button', { name: 'Use Claude Code' })).toBeEnabled();
    expect(cli.getByRole('button', { name: 'Use Copilot' })).toBeEnabled();

    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    const appearance = await screen.findByRole('heading', { name: 'Appearance' });
    expect(appearance).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Text size' })).getByRole('radio', {
        name: 'Large',
      }),
    );
    expect(JSON.parse(window.localStorage.getItem('cw-ui-prefs') ?? '{}')).toMatchObject({
      textSize: 'large',
    });
    await waitFor(() => expect(window.localStorage.getItem('cw-theme')).toBe('dark'));

    fireEvent.click(screen.getByRole('tab', { name: 'Network' }));
    expect(await screen.findByRole('heading', { name: 'Network activity' })).toBeInTheDocument();
    expect(screen.getByText(/integrations/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'System' }));
    expect(await screen.findByRole('heading', { name: 'Diagnostics & recovery' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Retained clipboard images' })).toBeInTheDocument();
    expect(await screen.findByText('No retained clipboard images.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review worktrees' })).toBeInTheDocument();
    expect(await screen.findByText(/review\/42/)).toBeInTheDocument();
    expect(retainedList).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByText('No review worktrees on disk.')).toBeInTheDocument());
    expect(api.removeWorktree).toHaveBeenCalledWith(worktrees.length === 0
      ? 'C:\\repo\\.ai-worktrees\\review-42'
      : worktrees[0].path);
    expect(api.listWorktrees).toHaveBeenCalledTimes(3);

    first.unmount();
    renderSettings(api);
    fireEvent.click(screen.getByRole('tab', { name: 'Tools & CLIs' }));
    await waitFor(() => expect(
      within(screen.getByRole('region', { name: 'CLI selection' })).getByText('Active CLI:'),
    ).toHaveTextContent('Active CLI: Claude Code'));
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code settings' }));
    expect(screen.getByRole('button', { name: 'Use Claude Code' })).toBeEnabled();
    fireEvent.click(await screen.findByRole('tab', { name: 'Appearance' }));
    expect(await screen.findByRole('radio', { name: 'Large' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
  });

  it.each([false, true])('offers Agency only when included in eligible bootstrap providers (eligible: %s)', async (eligible) => {
    const api = apiFor([], {
      getProviderBootstrap: vi.fn().mockResolvedValue({
        defaultProvider: 'copilot',
        selectionRequired: false,
        microsoftSignedIn: true,
        providers: [
          { id: 'copilot', installed: true },
          ...(eligible ? [{ id: 'agency', installed: true }] : []),
        ],
      }),
    });
    renderSettings(api);
    fireEvent.click(screen.getByRole('tab', { name: 'Tools & CLIs' }));
    const cli = within(screen.getByRole('region', { name: 'CLI selection' }));
    await waitFor(() => expect(cli.getByText('Active CLI:')).toHaveTextContent('Active CLI: Copilot'));
    fireEvent.click(cli.getByRole('button', { name: 'Copilot settings' }));
    expect(cli.getByRole('button', { name: 'Use Copilot' })).toBeEnabled();
    if (eligible) {
      fireEvent.click(cli.getByRole('button', { name: 'Agency settings' }));
      expect(cli.getByRole('button', { name: 'Use Agency' })).toBeEnabled();
    } else {
      expect(cli.queryByRole('button', { name: 'Agency settings' })).not.toBeInTheDocument();
      expect(cli.queryByRole('button', { name: 'Use Agency' })).not.toBeInTheDocument();
      expect(cli.queryByRole('heading', { name: 'Agency' })).not.toBeInTheDocument();
    }
    expect(api.selectProvider).not.toHaveBeenCalled();
  });

  it('surfaces worktree removal failures without hiding the real section', async () => {
    const api = apiFor([worktree()], {
      removeWorktree: vi.fn().mockRejectedValue(new Error('worktree is busy')),
    });
    renderSettings(api);

    fireEvent.click(await screen.findByRole('tab', { name: 'System' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    expect(await screen.findByText('worktree is busy')).toBeInTheDocument();
    expect(screen.getByText(/review\/42/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry removal' })).toBeEnabled();
  });

  it('shows crash evidence, copies a complete report, clears renderer failures, and retries restart', async () => {
    recordFailure('Renderer journey', new Error('renderer failed'));
    const copied: string[] = [];
    const relaunch = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const api = apiFor([], {
      listWorktrees: vi.fn().mockResolvedValue([]),
    });
    (window as unknown as { desktop: unknown }).desktop = {
      getVersion: vi.fn().mockResolvedValue('0.11.5'),
      backendDiagnostics: vi.fn().mockResolvedValue({
        logDirectory: 'C:\\logs',
        failures: [{
          at: '2026-09-10T10:00:00.000Z',
          kind: 'exit',
          code: 1,
          stderrTail: 'Error: backend crashed',
        }],
      }),
      copyText: vi.fn().mockImplementation(async (value: string) => {
        copied.push(value);
        return { ok: true };
      }),
      relaunch,
      attachments: {
        list: vi.fn().mockResolvedValue({
          status: 'ready',
          items: [],
          totalBytes: 0,
          limits: { files: 64, totalBytes: 64 * 1024 * 1024, fileBytes: 8 * 1024 * 1024 },
        }),
        remove: vi.fn().mockResolvedValue({ status: 'cancelled' }),
      },
    };

    renderSettings(api);
    fireEvent.click(await screen.findByRole('tab', { name: 'System' }));
    expect(await screen.findByText('Backend exited with code 1')).toBeInTheDocument();
    expect(screen.getByText('Error: backend crashed')).toBeInTheDocument();
    expect(screen.getByText('Renderer journey')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    await waitFor(() => expect(copied).toHaveLength(1));
    const report = JSON.parse(copied[0]) as {
      recentFailures: Array<{ message: string }>;
      backendFailures: Array<{ code: number }>;
    };
    expect(report.recentFailures[0].message).toBe('renderer failed');
    expect(report.backendFailures[0].code).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(await screen.findByText('No failures recorded this session.')).toBeInTheDocument();
    expect(screen.getByText('Backend exited with code 1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Restart app' }));
    expect(await screen.findByText(/Restart not confirmed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restart app' }));
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Restart not confirmed/)).toBeNull();
  });
});
