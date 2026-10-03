import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { SystemHealthReport } from '../../lib/types.js';
import { HealthSection } from './health-section.js';

afterEach(cleanup);

function report(overrides: Partial<SystemHealthReport> = {}): SystemHealthReport {
  return {
    generatedAt: '2024-01-01T00:00:00.000Z',
    overall: 'ok',
    checks: [
      { id: 'api', title: 'Backend API', state: 'ok', latencyMs: 1 },
      { id: 'persistence', title: 'Persistence (database)', state: 'down', detail: 'Timed out after 2000ms', latencyMs: 2000 },
    ],
    providers: [
      { id: 'copilot', title: 'GitHub Copilot CLI', installed: true, version: '1.2.3' },
      { id: 'agency', title: 'Agency', installed: false, detail: 'Not installed — installs automatically on first use.' },
    ],
    ...overrides,
  };
}

function makeApi(over: Partial<ApiClient> = {}): Partial<ApiClient> {
  return {
    getSystemHealth: vi.fn().mockResolvedValue(report()),
    checkHealth: vi.fn().mockResolvedValue({ status: 'ok', uptimeMs: 3_661_000 }),
    getConfig: vi.fn().mockResolvedValue({ current: {}, schema: {}, namespaces: [] }),
    getProviderBootstrap: vi.fn().mockResolvedValue({ defaultProvider: 'copilot', providers: [] }),
    getAgencyStatus: vi.fn().mockResolvedValue({ installed: true }),
    ...over,
  };
}

function renderSection(
  api: Partial<ApiClient>,
  props: Partial<Parameters<typeof HealthSection>[0]> = {},
) {
  return render(
    <ApiProvider value={api as ApiClient}>
      <HealthSection pollMs={0} {...props} />
    </ApiProvider>,
  );
}

it('renders the overall hero, app info, live endpoints, checks, and providers', async () => {
  renderSection(makeApi(), { version: '9.9.9', logDirectory: 'C:/logs' });
  expect(await screen.findByText('All systems operational')).toBeInTheDocument();
  expect(screen.getByText('App version')).toBeInTheDocument();
  expect(screen.getByText('9.9.9')).toBeInTheDocument();
  expect(screen.getByText('1h 1m')).toBeInTheDocument();
  expect(screen.getByText('C:/logs')).toBeInTheDocument();
  expect(screen.getByText('GET /health')).toBeInTheDocument();
  expect(screen.getByText('GET /system-health')).toBeInTheDocument();
  expect(screen.getByText('Backend API')).toBeInTheDocument();
  expect(screen.getByText('Timed out after 2000ms')).toBeInTheDocument();
  expect(screen.getByText('GitHub Copilot CLI')).toBeInTheDocument();
  expect(screen.getByText('v1.2.3')).toBeInTheDocument();
  expect(screen.getByText('Not installed — installs automatically on first use.')).toBeInTheDocument();
});

it('shows a degraded headline', async () => {
  renderSection(makeApi({ getSystemHealth: vi.fn().mockResolvedValue(report({ overall: 'degraded' })) }));
  expect(await screen.findByText('Running with degraded subsystems')).toBeInTheDocument();
});

it('renders a route row even when that endpoint ping fails', async () => {
  renderSection(makeApi({ getConfig: vi.fn().mockRejectedValue(new Error('boom')) }));
  await screen.findByText('All systems operational');
  expect(screen.getByText('GET /config')).toBeInTheDocument();
});

it('still renders live endpoints when the system report is unavailable', async () => {
  renderSection(makeApi({ getSystemHealth: vi.fn().mockRejectedValue(new Error('down')) }));
  await screen.findByText('GET /health');
  expect(screen.getByText('Subsystem report unavailable.')).toBeInTheDocument();
  expect(screen.getByText('Provider report unavailable.')).toBeInTheDocument();
});

it('refreshes on demand', async () => {
  const api = makeApi();
  renderSection(api);
  await screen.findByText('All systems operational');
  const before = (api.getSystemHealth as ReturnType<typeof vi.fn>).mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
  await waitFor(() =>
    expect((api.getSystemHealth as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before),
  );
});

it('restarts the app via the desktop bridge', async () => {
  const relaunch = vi.fn().mockResolvedValue(true);
  renderSection(makeApi(), { bridge: { relaunch } });
  await screen.findByText('All systems operational');
  fireEvent.click(screen.getByRole('button', { name: /Restart app/ }));
  await waitFor(() => expect(relaunch).toHaveBeenCalled());
});

it('reveals the log directory when clicked', async () => {
  const revealFile = vi.fn();
  renderSection(makeApi(), { bridge: { revealFile }, logDirectory: 'C:/logs' });
  await screen.findByText('All systems operational');
  fireEvent.click(screen.getByRole('button', { name: /Log directory/ }));
  expect(revealFile).toHaveBeenCalledWith('C:/logs');
});
