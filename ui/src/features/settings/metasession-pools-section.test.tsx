import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import { MetasessionPoolsSection } from './metasession-pools-section.js';

afterEach(() => {
  cleanup();
  delete (window as unknown as { desktop?: unknown }).desktop;
});

it.each(['resize', 'create', 'remove'] as const)('reports a failed live %s without losing the requested target and permits retry', async (failure) => {
  const resize = vi.fn().mockResolvedValue({});
  const create = vi.fn().mockResolvedValue({});
  const remove = vi.fn().mockResolvedValue({});
  ({ resize, create, remove })[failure].mockRejectedValueOnce(new Error('native operation failed'));
  const config = vi.fn().mockResolvedValueOnce({
    current: { meta: { warmPool: { enabled: true, pools: [
      { purpose: 'general', size: 2 }, { purpose: 'review', size: 1 },
    ] } } },
  }).mockImplementation(() => new Promise(() => {}));
  const pool = (purpose: string) => ({
    purpose, size: 2, suggestedSize: 2, live: 0, idle: 0, busy: 0,
    ready: false, served: 0, sessions: [],
  });
  const api: Partial<ApiClient> = {
    getConfig: config,
    getMetaPools: vi.fn().mockResolvedValue({ enabled: true, pools: [pool('general'), pool('obsolete')] }),
    getMetaSettings: vi.fn().mockResolvedValue({ model: 'fixture' }),
    getMetaModels: vi.fn().mockResolvedValue([{ id: 'fixture', name: 'Fixture' }]),
    updateConfig: vi.fn().mockResolvedValue({}),
    resizeMetaPool: resize, createMetaPool: create, removeMetaPool: remove,
  };
  render(<ApiProvider value={api as ApiClient}><MetasessionPoolsSection /></ApiProvider>);
  fireEvent.change(await screen.findByDisplayValue('2'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText(/Configuration saved, but some live pool changes failed/)).toBeInTheDocument();
  expect(screen.queryByText('Saved — applied live.')).toBeNull();
  expect(resize).toHaveBeenCalledWith('general', 1);
  expect(create).toHaveBeenCalledWith('review', 1);
  expect(remove).toHaveBeenCalledWith('obsolete');
  expect(config).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText('Saved — applied live.')).toBeInTheDocument();
  await waitFor(() => expect(resize).toHaveBeenCalledTimes(2));
  expect(resize).toHaveBeenLastCalledWith('general', 1);
  expect(screen.queryByText(/some live pool changes failed/)).toBeNull();
});

it('keeps a saved pool size after the config reloads', async () => {
  // The running config is a boot snapshot that never moves, so reading it
  // alone made a saved size snap back to the old value on reload while the
  // live pool had already been resized to the new one.
  const running = { meta: { warmPool: { enabled: true, pools: [{ purpose: 'general', size: 2 }] } } };
  const getConfig = vi.fn()
    .mockResolvedValueOnce({ current: running, overrides: { meta: {} } })
    .mockResolvedValue({
      current: running,
      overrides: { meta: { warmPool: { enabled: true, pools: [{ purpose: 'general', size: 7 }] } } },
    });
  const api: Partial<ApiClient> = {
    getConfig,
    getMetaPools: vi.fn().mockResolvedValue({
      enabled: true,
      pools: [{
        purpose: 'general', size: 2, suggestedSize: 2, live: 2, idle: 2, busy: 0,
        ready: true, served: 0, sessions: [],
      }],
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
});

it.each([false, true])('shows capacity-blocked targets and actual headless budgets (closed=%s)', async (closed) => {
  const api: Partial<ApiClient> = {
    getConfig: vi.fn().mockResolvedValue({
      current: { meta: { warmPool: { enabled: true, pools: [{ purpose: 'general', size: 6 }] } } },
    }),
    getMetaPools: vi.fn().mockResolvedValue({
      enabled: true,
      processAdmission: { processes: 8, warmProcesses: 4, queued: 2, closed,
        maxProcesses: 8, maxWarmProcesses: 4, maxQueued: 32 },
      pools: [{
        purpose: 'general', size: 6, suggestedSize: 6, live: 1, idle: 1, busy: 0,
        ready: true, served: 0, waitingForCapacity: true,
        sessions: [{ id: 'meta-1', state: 'idle', served: 0, startedAt: 0,
          lastActiveAt: null, inputTokens: 0, outputTokens: 0, history: [] }],
      }],
    }),
    getMetaSettings: vi.fn().mockResolvedValue({ model: 'fixture' }),
    getMetaModels: vi.fn().mockResolvedValue([{ id: 'fixture', name: 'Fixture' }]),
  };
  render(<ApiProvider value={api as ApiClient}><MetasessionPoolsSection /></ApiProvider>);
  expect(await screen.findByText(/Waiting for shared process capacity/))
    .toHaveTextContent('1 of 6 ready, 0 warming');
  expect(screen.getByDisplayValue('6')).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(6);
  expect(screen.getAllByLabelText(/Waiting for shared process capacity/)).toHaveLength(5);
  expect(screen.getByText(/Headless process budget:/)).toHaveTextContent('8/8 processes, 4/4 warm; queue 2/32');
  expect(screen.queryByText(/Metasessions decreasing/)).toBeNull();
  expect(screen.getByText(/Headless process budget:/).textContent?.includes('Process admission is closed')).toBe(closed);
});

it('surfaces a failed live pool request and recovers without misreporting that a saved pool needs saving', async () => {
  const pool = {
    purpose: 'general', size: 1, suggestedSize: 1, live: 1, idle: 1, busy: 0,
    ready: true, served: 0, sessions: [{ id: 's1', state: 'idle' as const, served: 0,
      startedAt: 0, lastActiveAt: null, inputTokens: 0, outputTokens: 0, history: [] }],
  };
  const getMetaPools = vi.fn()
    .mockRejectedValueOnce(new Error('Request timed out: /meta/pools'))
    .mockResolvedValue({ enabled: true, pools: [pool] });
  const api: Partial<ApiClient> = {
    getConfig: vi.fn().mockResolvedValue({
      current: { meta: { warmPool: { enabled: true, pools: [{ purpose: 'general', size: 1 }] } } },
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
      current: { meta: { warmPool: { enabled: false, pools: [{ purpose: 'general', size: 1 }] } } },
    }).mockImplementation(() => new Promise(() => {})),
    getMetaPools: vi.fn().mockResolvedValue({ enabled: false, pools: [] }),
    getMetaSettings: vi.fn().mockResolvedValue({ model: 'fixture' }),
    getMetaModels: vi.fn().mockResolvedValue([{ id: 'fixture', name: 'Fixture' }]),
    updateConfig: vi.fn().mockResolvedValue({}),
  };
  render(<ApiProvider value={api as ApiClient}><MetasessionPoolsSection /></ApiProvider>);
  await screen.findByDisplayValue('general');
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Keep metasessions warm' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Restart now' }));
  expect(await screen.findByText(/Restart not confirmed/)).toBeInTheDocument();
  expect(screen.queryByText('private detail')).toBeNull();
  expect(screen.getByRole('button', { name: 'Restart now' })).toBeEnabled();
});
