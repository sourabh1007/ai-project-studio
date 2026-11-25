import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import { MetasessionPoolsSection } from './metasession-pools-section.js';

afterEach(() => {
  cleanup();
  delete (window as unknown as { desktop?: unknown }).desktop;
});

it('keeps Agency dashboard visible with actual on-demand sessions and read-only live details', async () => {
  const entry = { id: 'meta:agency-live', sessionId: 'agency-live', kind: 'meta', transport: 'session',
    state: 'busy', label: 'Review change', purpose: 'review-board', featureId: 'f',
    featureName: 'Development', projectName: 'CosmosDB', operationId: 'op', provider: 'agency', model: 'auto' };
  const workspace = { ...entry, id: 'terminal', kind: 'session' };
  const debug = vi.fn().mockResolvedValue({ sampledAt: 1000, entry, state: 'running',
    activity: ['Reading captured review input'], output: 'Actual recorded output', error: null, truncated: false });
  const updateConfig = vi.fn().mockResolvedValue({});
  const resizeMetaPool = vi.fn();
  const api: Partial<ApiClient> = {
    getConfig: vi.fn().mockResolvedValue({ current: { meta: { warmPool: { enabled: true, size: 10 } } } }),
    getMetaPools: vi.fn().mockResolvedValue({ enabled: false, availability: {
      state: 'unavailable', providerId: 'agency', message: 'This provider runs AI requests on demand; reusable warm sessions are not supported.',
    } }),
    getMetaSettings: vi.fn().mockResolvedValue({ providerId: 'agency', model: 'auto' }),
    getMetaModels: vi.fn().mockResolvedValue([]),
    getActiveSessions: vi.fn().mockResolvedValue({ sampledAt: 1000, pollMs: 3000, entries: [entry, workspace] }),
    getActiveSessionDebug: debug, updateConfig, resizeMetaPool,
  };
  render(<ApiProvider value={api as ApiClient}><MetasessionPoolsSection embedded /></ApiProvider>);
  expect(await screen.findByText('On demand')).toBeVisible();
  expect(screen.getByText('Agency', { selector: '.metapool-provider' })).toBeVisible();
  expect(screen.getAllByLabelText(/Metasession slot .*no live session/)).toHaveLength(10);
  expect(await screen.findByLabelText('Metasession Review change: busy. View live details')).toBeVisible();
  expect(debug).not.toHaveBeenCalled();
  expect(screen.queryByText('Save to start live')).toBeNull();
  expect(screen.queryByText('Starting…')).toBeNull();
  fireEvent.click(screen.getByLabelText('Metasession Review change: busy. View live details'));
  const dialog = screen.getByRole('dialog', { name: 'IDE metasession · Review change' });
  expect(await within(dialog).findByText('Actual recorded output')).toBeVisible();
  expect(dialog).toHaveTextContent('CosmosDB');
  expect(debug).toHaveBeenCalledWith(entry.id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText('Saved — settings retained.')).toBeVisible();
  expect(screen.queryByText('Saved — applied live.')).toBeNull();
  expect(screen.queryByText('Starting…')).toBeNull();
  expect(resizeMetaPool).not.toHaveBeenCalled();
  expect(updateConfig).toHaveBeenCalledOnce();
});

it('keeps stopped warm capacity visible and bounds configured placeholders without spawning sessions', async () => {
  const api: Partial<ApiClient> = {
    getConfig: vi.fn().mockResolvedValue({ current: { meta: { warmPool: { enabled: false, size: 100 } } } }),
    getMetaPools: vi.fn().mockResolvedValue({ enabled: false, availability: {
      state: 'disabled', providerId: 'copilot', message: 'Warm sessions are turned off.',
    } }),
    getMetaSettings: vi.fn().mockResolvedValue({ providerId: 'copilot', model: 'auto' }),
    getMetaModels: vi.fn().mockResolvedValue([]),
    getActiveSessions: vi.fn().mockResolvedValue({ sampledAt: 1000, pollMs: 3000, entries: [] }),
    updateConfig: vi.fn(), resizeMetaPool: vi.fn(),
  };
  render(<ApiProvider value={api as ApiClient}><MetasessionPoolsSection /></ApiProvider>);
  expect(await screen.findByText('Off')).toBeVisible();
  expect(screen.getAllByLabelText(/Metasession slot .*no live session/)).toHaveLength(32);
  expect(screen.getByText('+68 configured slots')).toBeVisible();
  expect(api.updateConfig).not.toHaveBeenCalled();
  expect(api.resizeMetaPool).not.toHaveBeenCalled();
  await act(async () => {});
});

it('reports a failed live resize without losing the requested target and permits retry', async () => {
  const resize = vi.fn().mockResolvedValue({});
  resize.mockRejectedValueOnce(new Error('native operation failed'));
  const config = vi.fn().mockResolvedValueOnce({
    current: { meta: { warmPool: { enabled: true, size: 2 } } },
  }).mockImplementation(() => new Promise(() => {}));
  const api: Partial<ApiClient> = {
    getConfig: config,
    getMetaPools: vi.fn().mockResolvedValue({
      enabled: true,
      pool: {
        size: 2, suggestedSize: 2, live: 0, idle: 0, busy: 0,
        ready: false, served: 0, sessions: [],
      },
    }),
    getMetaSettings: vi.fn().mockResolvedValue({ model: 'fixture' }),
    getMetaModels: vi.fn().mockResolvedValue([{ id: 'fixture', name: 'Fixture' }]),
    updateConfig: vi.fn().mockResolvedValue({}),
    resizeMetaPool: resize,
  };
  render(<ApiProvider value={api as ApiClient}><MetasessionPoolsSection /></ApiProvider>);
  fireEvent.change(await screen.findByDisplayValue('2'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText(/resizing the running pool failed/)).toBeInTheDocument();
  expect(screen.queryByText('Saved — applied live.')).toBeNull();
  expect(resize).toHaveBeenCalledWith(1);
  expect(config).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText('Saved — applied live.')).toBeInTheDocument();
  await waitFor(() => expect(resize).toHaveBeenCalledTimes(2));
  expect(resize).toHaveBeenLastCalledWith(1);
  expect(screen.queryByText(/resizing the running pool failed/)).toBeNull();
});

it('restores colored session chips with live details, session-specific usage and availability charts, not a shared capacity metric', async () => {
  const session = {
    id: 's1', state: 'busy', served: 1, startedAt: 1000, lastActiveAt: 2000,
    inputTokens: 120, outputTokens: 30,
    history: [{ at: 3000, purpose: 'review-board', label: 'Review code', inputTokens: 120, outputTokens: 30,
      prompt: 'Review this change', response: 'Recorded response' }],
    live: { purpose: 'review-board', label: 'Review next change', startedAt: 4000,
      prompt: 'Current prompt', response: 'Current response' },
  };
  const api: Partial<ApiClient> = {
    getConfig: vi.fn().mockResolvedValue({ current: { meta: { warmPool: { enabled: true, size: 1 } } } }),
    getMetaPools: vi.fn().mockResolvedValue({
      enabled: true, pool: { size: 1, suggestedSize: 1, live: 1, idle: 0, busy: 1, ready: true, served: 1, sessions: [session] },
      history: { error: null, samples: [{ at: 3000, provider: 'agency', model: null, queued: 0 }] },
    }),
    getMetaSettings: vi.fn().mockResolvedValue({ model: 'fixture' }),
    getMetaModels: vi.fn().mockResolvedValue([{ id: 'fixture', name: 'Fixture' }]),
  };
  render(<ApiProvider value={api as ApiClient}><MetasessionPoolsSection /></ApiProvider>);
  const icon = await screen.findByLabelText('Metasession s1: Busy, 1 turns. View details');
  expect(icon).toHaveTextContent('s1');
  expect(icon).toHaveTextContent('1');
  expect(icon).toHaveAttribute('aria-haspopup', 'dialog');
  expect(screen.queryByText('Capacity trends')).toBeNull();
  fireEvent.click(icon);
  const dialog = screen.getByRole('dialog', { name: 'Metasession s1' });
  expect(dialog).toHaveTextContent('Current prompt');
  expect(dialog).toHaveTextContent('Current response');
  expect(within(dialog).getByRole('img', { name: /Session token usage:.*maximum 150 tokens/ })).toBeInTheDocument();
  expect(within(dialog).getByRole('img', { name: /Session availability:/ })).toBeInTheDocument();
  expect(dialog).toHaveTextContent('Busy is normal, not unhealthy');
  expect(within(dialog).queryByLabelText('Metric')).toBeNull();
  fireEvent.click(within(dialog).getByText('Review code', { selector: 'span' }));
  expect(dialog).toHaveTextContent('Review this change');
  expect(dialog).toHaveTextContent('Recorded response');
});

it('rejects a size below one without calling the backend', async () => {
  const resize = vi.fn().mockResolvedValue({});
  const updateConfig = vi.fn().mockResolvedValue({});
  const api: Partial<ApiClient> = {
    getConfig: vi.fn().mockResolvedValue({
      current: { meta: { warmPool: { enabled: true, size: 2 } } },
    }),
    getMetaPools: vi.fn().mockResolvedValue({ enabled: true }),
    getMetaSettings: vi.fn().mockResolvedValue({ model: 'fixture' }),
    getMetaModels: vi.fn().mockResolvedValue([{ id: 'fixture', name: 'Fixture' }]),
    updateConfig,
    resizeMetaPool: resize,
  };
  render(<ApiProvider value={api as ApiClient}><MetasessionPoolsSection /></ApiProvider>);
  fireEvent.change(await screen.findByDisplayValue('2'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText(/whole size of at least 1/)).toBeInTheDocument();
  expect(updateConfig).not.toHaveBeenCalled();
  expect(resize).not.toHaveBeenCalled();
});

it('keeps a saved pool size after the config reloads', async () => {
  // The running config is a boot snapshot that never moves, so reading it
  // alone made a saved size snap back to the old value on reload while the
  // live pool had already been resized to the new one.
  const running = { meta: { warmPool: { enabled: true, size: 2 } } };
  const getConfig = vi.fn()
    .mockResolvedValueOnce({ current: running, overrides: { meta: {} } })
    .mockResolvedValue({
      current: running,
      overrides: { meta: { warmPool: { enabled: true, size: 7 } } },
    });
  const api: Partial<ApiClient> = {
    getConfig,
    getMetaPools: vi.fn().mockResolvedValue({
      enabled: true,
      pool: {
        size: 2, suggestedSize: 2, live: 2, idle: 2, busy: 0,
        ready: true, served: 0, sessions: [],
      },
    }),
    getMetaSettings: vi.fn().mockResolvedValue({ model: 'fixture' }),
    getMetaModels: vi.fn().mockResolvedValue([{ id: 'fixture', name: 'Fixture' }]),
    updateConfig: vi.fn().mockResolvedValue({}),
    resizeMetaPool: vi.fn().mockResolvedValue({}),
  };
  render(<ApiProvider value={api as ApiClient}><MetasessionPoolsSection /></ApiProvider>);
  fireEvent.change(await screen.findByDisplayValue('2'), { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(2));
  expect(await screen.findByDisplayValue('7')).toBeInTheDocument();
  expect(screen.queryByDisplayValue('2')).toBeNull();
  expect(screen.getByText('Saved — applied live.')).toBeVisible();
});

it.each([false, true])('shows capacity-blocked targets and actual headless budgets (closed=%s)', async (closed) => {
  const api: Partial<ApiClient> = {
    getConfig: vi.fn().mockResolvedValue({
      current: { meta: { warmPool: { enabled: true, size: 6 } } },
    }),
    getMetaPools: vi.fn().mockResolvedValue({
      enabled: true,
      processAdmission: { processes: 8, warmProcesses: 4, queued: 2, closed,
        maxProcesses: 8, maxWarmProcesses: 4, maxQueued: 32 },
      pool: {
        size: 6, suggestedSize: 6, live: 1, idle: 1, busy: 0,
        ready: true, served: 0, waitingForCapacity: true,
        sessions: [{ id: 'meta-1', state: 'idle', served: 0, startedAt: 0,
          lastActiveAt: null, inputTokens: 0, outputTokens: 0, history: [] }],
      },
    }),
    getMetaSettings: vi.fn().mockResolvedValue({ model: 'fixture' }),
    getMetaModels: vi.fn().mockResolvedValue([{ id: 'fixture', name: 'Fixture' }]),
  };
  render(<ApiProvider value={api as ApiClient}><MetasessionPoolsSection /></ApiProvider>);
  expect(await screen.findByText(/Waiting for shared process capacity/))
    .toHaveTextContent('1 of 6 ready, 0 warming');
  expect(screen.getByDisplayValue('6')).toBeInTheDocument();
  // The live session chip is animated in, so wait for it before counting the
  // ghost slots that make up the rest of the configured target.
  await screen.findByTitle(/^meta-1 · Idle/);
  expect(screen.getAllByRole('listitem')).toHaveLength(6);
  expect(screen.getAllByLabelText(/Waiting for shared process capacity/)).toHaveLength(5);
  expect(screen.getByText(/Headless process budget:/)).toHaveTextContent('8/8 processes, 4/4 warm; queue 2/32');
  expect(screen.queryByText(/Metasessions decreasing/)).toBeNull();
  expect(screen.getByText(/Headless process budget:/).textContent?.includes('Process admission is closed')).toBe(closed);
});

it('surfaces a failed live pool request and recovers without misreporting that a saved pool needs saving', async () => {
  const pool = {
    size: 1, suggestedSize: 1, live: 1, idle: 1, busy: 0,
    ready: true, served: 0, sessions: [{ id: 's1', state: 'idle' as const, served: 0,
      startedAt: 0, lastActiveAt: null, inputTokens: 0, outputTokens: 0, history: [] }],
  };
  const getMetaPools = vi.fn()
    .mockRejectedValueOnce(new Error('Request timed out: /meta/pools'))
    .mockResolvedValue({ enabled: true, pool });
  const api: Partial<ApiClient> = {
    getConfig: vi.fn().mockResolvedValue({
      current: { meta: { warmPool: { enabled: true, size: 1 } } },
    }),
    getMetaPools,
    getMetaSettings: vi.fn().mockResolvedValue({ model: 'fixture' }),
    getMetaModels: vi.fn().mockResolvedValue([{ id: 'fixture', name: 'Fixture' }]),
  };
  render(<ApiProvider value={api as ApiClient}><MetasessionPoolsSection /></ApiProvider>);
  expect(await screen.findByText('Live status unavailable')).toBeInTheDocument();
  expect(screen.queryByText('Save to start live')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Ready')).toBeInTheDocument();
  expect(getMetaPools).toHaveBeenCalledTimes(2);
});

it.each([false, 'reject'] as const)('reports a failed pool-settings restart (%s) without claiming it applied', async (failure) => {
  const relaunch = vi.fn(() => failure === 'reject'
    ? Promise.reject(new Error('private detail')) : Promise.resolve(false));
  (window as unknown as { desktop: unknown }).desktop = { relaunch };
  const api: Partial<ApiClient> = {
    getConfig: vi.fn().mockResolvedValueOnce({
      current: { meta: { warmPool: { enabled: false, size: 1 } } },
    }).mockImplementation(() => new Promise(() => {})),
    getMetaPools: vi.fn().mockResolvedValue({ enabled: false }),
    getMetaSettings: vi.fn().mockResolvedValue({ model: 'fixture' }),
    getMetaModels: vi.fn().mockResolvedValue([{ id: 'fixture', name: 'Fixture' }]),
    updateConfig: vi.fn().mockResolvedValue({}),
  };
  render(<ApiProvider value={api as ApiClient}><MetasessionPoolsSection /></ApiProvider>);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Keep metasessions warm' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Restart now' }));
  expect(await screen.findByText(/Restart not confirmed/)).toBeInTheDocument();
  expect(screen.queryByText('private detail')).toBeNull();
  expect(screen.getByRole('button', { name: 'Restart now' })).toBeEnabled();
});

it('renders metasession controls without the page heading when embedded', async () => {
  const api: Partial<ApiClient> = {
    getConfig: vi.fn().mockResolvedValue({
      current: { meta: { warmPool: { enabled: true, size: 2 } } },
    }),
    getMetaPools: vi.fn().mockResolvedValue({
      enabled: true,
      pool: {
        size: 2, suggestedSize: 2, live: 0, idle: 0, busy: 0,
        ready: false, served: 0, sessions: [],
      },
    }),
    getMetaSettings: vi.fn().mockResolvedValue({ model: 'fixture' }),
    getMetaModels: vi.fn().mockResolvedValue([{ id: 'fixture', name: 'Fixture' }]),
  };
  render(<ApiProvider value={api as ApiClient}><MetasessionPoolsSection embedded /></ApiProvider>);
  expect(screen.queryByRole('heading', { name: 'Metasessions' })).toBeNull();
  expect(await screen.findByText('Keep metasessions warm')).toBeInTheDocument();
  expect(screen.getByText(/Warm AI sessions kept ready/)).toBeInTheDocument();
});