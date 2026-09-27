import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import { ResourcePanel } from './resource-panel.js';
import type { AppResourceSnapshot, ResourceCleanup } from './resource-types.js';
const bridge = vi.hoisted(() => ({ clearHttpCache: vi.fn() }));
const desktop = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../lib/desktop-bridge.js', () => ({ desktopBridge: () => desktop.enabled ? bridge : null }));

function snapshot(): AppResourceSnapshot {
  return {
    measuredAt: 1000, staleAfterMs: 30_000,
    processes: {
      status: 'ready', sampledAt: 1000, error: null, rootPid: 1, cpuPercent: 12.5, memoryBytes: 1024 ** 3,
      items: [
        { pid: 2, parentPid: 1, name: 'node', role: 'Backend', startedAt: null, cpuPercent: 10, memoryBytes: 1024 },
        { pid: 3, parentPid: 1, name: 'electron', role: 'UI renderer', startedAt: null, cpuPercent: 2.5, memoryBytes: 2048 },
      ],
    },
    storage: {
      status: 'ready', scannedAt: 1000, error: null,
      categories: [
        { id: 'trees', kind: 'worktrees', label: 'Worktrees', paths: ['C:\\app\\trees'], bytes: 4096, cleanupSupported: false, cleanupReason: 'Use Worktree settings', error: null },
        { id: 'logs', kind: 'logs', label: 'App logs', paths: ['C:\\app\\logs'], bytes: 1024, cleanupSupported: true, cleanupReason: 'Active logs are protected', error: null },
        { id: 'cache', kind: 'cache', label: 'App cache', paths: ['C:\\app\\cache'], bytes: 2048, cleanupSupported: true, cleanupReason: null, error: null },
      ],
      volumes: [{ path: 'C:\\', totalBytes: 1024 ** 4, freeBytes: 1024 ** 3, error: null }],
    },
    cleanups: [],
  };
}
const connection = { state: 'online' as const, healthy: true, title: 'Online', detail: '', probeFailed: false };
function setup(data: AppResourceSnapshot | null = snapshot(), api: Partial<ApiClient> = {}) {
  const callbacks = { refresh: vi.fn().mockResolvedValue(undefined), onClose: vi.fn(), onManageWorktrees: vi.fn() };
  const renderPanel = (next: AppResourceSnapshot | null, error: string | null = null) =>
    <ApiProvider value={api as ApiClient}><ResourcePanel {...callbacks} snapshot={next} error={error} loading={false} now={2000} connection={connection} /></ApiProvider>;
  const view = render(renderPanel(data));
  return { ...callbacks, view, rerender: (next: AppResourceSnapshot | null, error: string | null = null) => view.rerender(renderPanel(next, error)) };
}
afterEach(() => { desktop.enabled = false; vi.restoreAllMocks(); });

describe('app resource panel', () => {
  it('uses the safe Electron HTTP cache API only after confirmation and surfaces failures', async () => {
    desktop.enabled = true;
    bridge.clearHttpCache.mockResolvedValueOnce({ status: 'completed', error: null })
      .mockResolvedValueOnce({ status: 'failed', error: 'Cache busy' });
    const cleanResourceStorage = vi.fn();
    setup(snapshot(), { cleanResourceStorage, refreshResourceStorage: vi.fn().mockResolvedValue(snapshot()) });
    fireEvent.click(screen.getByRole('button', { name: 'Clear Electron HTTP cache' }));
    expect(bridge.clearHttpCache).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Confirm cache cleanup' })).toHaveTextContent('Cookies, sign-in');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm clean cache' }));
    await screen.findByText(/Electron HTTP cache cleared/);
    expect(bridge.clearHttpCache).toHaveBeenCalledOnce();
    expect(cleanResourceStorage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear Electron HTTP cache' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm clean cache' }));
    await screen.findByText('Cache busy');
  });
  it('separates app totals, per-process details, storage paths and host measurements', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'App resources' })).toBeTruthy();
    expect(screen.getByText('12.5%')).toBeTruthy();
    expect(screen.getByText('Backend')).toBeTruthy();
    expect(screen.getByText('UI renderer')).toBeTruthy();
    expect(screen.getByText('C:\\app\\trees')).toBeTruthy();
    expect(screen.getByText('1 GB free / 1024 GB capacity')).toBeTruthy();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')[1].textContent).toContain('node');
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'memory' } });
    expect(within(table).getAllByRole('row')[1].textContent).toContain('electron');
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'cpu' } });
    expect(within(table).getAllByRole('row')[1].textContent).toContain('node');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '3' } });
    expect(within(table).queryByText('node')).toBeNull();
    expect(within(table).getByText('electron')).toBeTruthy();
  });
  it('navigates to worktree settings, never deletes worktrees from resource cleanup', () => {
    const { onManageWorktrees } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Manage worktrees' }));
    expect(onManageWorktrees).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Clean worktrees' })).toBeNull();
  });
  it('confirms scoped cleanup and shows independent asynchronous progress and completion', async () => {
    const job: ResourceCleanup = { id: 'job', category: 'logs', status: 'running', removedBytes: 0, removedFiles: 0, skippedFiles: 0, error: null };
    const cleanResourceStorage = vi.fn().mockResolvedValue(job);
    const { rerender, refresh } = setup(snapshot(), { cleanResourceStorage });
    fireEvent.click(screen.getByRole('button', { name: 'Clean logs' }));
    expect(cleanResourceStorage).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Confirm logs cleanup' })).toHaveTextContent('C:\\app\\logs');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm clean logs' }));
    await act(async () => {});
    expect(cleanResourceStorage).toHaveBeenCalledWith('logs');
    expect(screen.getByRole('button', { name: 'Cleaning logs…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clean cache' })).toBeEnabled();
    expect(refresh).toHaveBeenCalled();
    const next = snapshot(); next.cleanups = [{ ...job, status: 'completed', removedBytes: 1024, removedFiles: 2, skippedFiles: 1 }];
    next.storage.categories[1].bytes = 128;
    next.storage.categories[1].pathDetails = [{
      path: 'C:\\app\\logs', bytes: 128, measuredAt: 2000, status: 'ready', errors: [],
    }];
    rerender(next);
    expect(within(screen.getByRole('region', { name: 'App logs' })).getAllByText(/128 B/).length).toBeGreaterThan(0);
    expect(screen.getByText('6.1 KB')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clean logs' })).toBeEnabled();
    expect(screen.getByText(/Logs: completed/)).toHaveTextContent('2 files removed (1 KB) · 1 protected/busy files skipped');
  });
  it('shows actionable errors and preserves navigation when a scan or cleanup fails', async () => {
    const api = { refreshResourceStorage: vi.fn().mockRejectedValue(new Error('Disk inaccessible')), cleanResourceStorage: vi.fn().mockRejectedValue(new Error('Protected path')) };
    setup(snapshot(), api);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh disk usage' }));
    await screen.findByText('Disk inaccessible');
    expect(screen.getByRole('button', { name: 'Manage worktrees' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Clean cache' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.cleanResourceStorage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clean cache' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm clean cache' }));
    await screen.findByText('Protected path');
    expect(screen.getByRole('button', { name: 'Clean cache' })).toBeEnabled();
  });
  it('does not invent zero usage for unavailable data and labels stale or partial measurements', () => {
    const data = snapshot();
    data.measuredAt = -50_000;
    data.processes.cpuPercent = null;
    data.processes.memoryBytes = null;
    data.storage.categories[0].bytes = null;
    const { rerender, refresh } = setup(data);
    expect(screen.getByText(/Measurements are stale/)).toBeTruthy();
    expect(screen.getByText('At least 3 KB')).toBeTruthy();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(1);
    rerender(null, 'Backend unreachable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry resource measurements' }));
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Clean logs' })).toBeNull();
  });
  it('shows per-path progress and partial measured bytes instead of hiding a large unfinished tree', () => {
    const data = snapshot();
    data.storage.status = 'scanning';
    data.storage.progress = { visitedEntries: 1234, scannedBytes: 8192, currentPath: 'Q:\\trees\\large' };
    data.storage.categories[0].bytes = null;
    data.storage.categories[0].pathDetails = [{
      path: 'C:\\app\\trees', bytes: 8192, measuredAt: 1000, status: 'partial', errors: ['Still scanning'],
    }];
    setup(data);
    expect(screen.getByText('At least 11 KB')).toBeTruthy();
    expect(screen.getByText(/1,234 entries/)).toHaveTextContent('8 KB measured');
    expect(screen.getByText('Q:\\trees\\large')).toBeTruthy();
    expect(screen.getByText('Still scanning', { exact: false })).toBeTruthy();
  });
  it('keeps storage actions within App categories and drive capacity only in System', () => {
    setup();
    const system = screen.getByRole('region', { name: 'System' });
    const app = screen.getByRole('region', { name: 'App' });
    const logs = within(app).getByRole('region', { name: 'App logs' });
    const trees = within(app).getByRole('region', { name: 'Worktrees' });
    expect(within(logs).getByRole('button', { name: 'Clean logs' })).toBeTruthy();
    expect(within(trees).getByRole('button', { name: 'Manage worktrees' })).toBeTruthy();
    expect(within(system).queryByText('C:\\app\\trees')).toBeNull();
    expect(within(system).getByText('C:\\')).toBeTruthy();
    expect(within(app).getByRole('columnheader', { name: 'Hard disk' })).toBeTruthy();
    expect(screen.getByRole('dialog')).toHaveClass('resource-modal');
    fireEvent.click(within(logs).getByRole('button', { name: 'Clean logs' }));
    expect(within(logs).getByRole('group', { name: 'Confirm logs cleanup' })).toBeTruthy();
  });
  it('keeps the default process order stable during live metric changes', () => {
    const data = snapshot();
    const { rerender } = setup(data);
    const firstPid = () => within(screen.getByRole('table')).getAllByRole('row')[1].textContent;
    expect(firstPid()).toContain('node');
    data.processes.items[0].memoryBytes = 1e9;
    rerender({ ...data, processes: { ...data.processes, items: [...data.processes.items] } });
    expect(firstPid()).toContain('node');
  });
});
