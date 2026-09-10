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
  return {
    getConfig: vi.fn().mockResolvedValue(config()),
    getVersion: vi.fn().mockResolvedValue('0.11.5'),
    getAgencyStatus: vi.fn().mockResolvedValue({ installed: false }),
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
    expect(screen.getByText('Agency CLI')).toBeInTheDocument();

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

    fireEvent.click(screen.getByRole('tab', { name: 'Diagnostics' }));
    expect(await screen.findByRole('heading', { name: 'Diagnostics & recovery' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Retained clipboard images' })).toBeInTheDocument();
    expect(await screen.findByText('No retained clipboard images.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review worktrees' })).toBeInTheDocument();
    expect(await screen.findByText(/review\/42/)).toBeInTheDocument();
    expect(retainedList).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByText('No review worktrees on disk.')).toBeInTheDocument());
    expect(api.removeWorktree).toHaveBeenCalledWith(worktrees.length === 0
      ? 'C:\\repo\\.ai-worktrees\\review-42'
      : worktrees[0].path);
    expect(api.listWorktrees).toHaveBeenCalledTimes(2);

    first.unmount();
    renderSettings(api);
    fireEvent.click(await screen.findByRole('tab', { name: 'Appearance' }));
    expect(await screen.findByRole('radio', { name: 'Large' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
  });

  it('surfaces worktree removal failures without hiding the real section', async () => {
    const api = apiFor([worktree()], {
      removeWorktree: vi.fn().mockRejectedValue(new Error('worktree is busy')),
    });
    renderSettings(api);

    fireEvent.click(await screen.findByRole('tab', { name: 'Diagnostics' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    expect(await screen.findByText('worktree is busy')).toBeInTheDocument();
    expect(screen.getByText(/review\/42/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
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
    fireEvent.click(await screen.findByRole('tab', { name: 'Diagnostics' }));
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
    expect(await screen.findByRole('alert')).toHaveTextContent('Restart not confirmed');
    fireEvent.click(screen.getByRole('button', { name: 'Restart app' }));
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
