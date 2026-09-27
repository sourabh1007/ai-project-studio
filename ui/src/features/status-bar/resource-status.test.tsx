import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResourceStatus } from './resource-status.js';
import type { MeasuredConnectionStatus } from '../../hooks/use-connection-status.js';

vi.mock('../resources/use-resource-monitor.js', () => ({
  useResourceMonitor: () => ({
    snapshot: { measuredAt: 1000, staleAfterMs: 30_000,
      processes: { status: 'ready', sampledAt: 1000, cpuPercent: 7, memoryBytes: 1024 }, storage: null },
    error: null, loading: false, refresh: vi.fn(),
  }),
}));
vi.mock('../resources/resource-panel.js', () => ({
  resourceBytes: (value: number) => `${value} bytes`,
  resourcePercent: (value: number) => `${value}%`,
  ResourcePanel: ({ onManageWorktrees, onClose }: { onManageWorktrees(): void; onClose(): void }) =>
    <div role="dialog"><button onClick={onManageWorktrees}>Manage worktrees</button><button onClick={onClose}>Close</button></div>,
}));
const connection: MeasuredConnectionStatus = {
  state: 'online', healthy: true, title: 'Connected', detail: '', probeFailed: false,
  resources: {
    status: 'pressure', reasons: ['high-cpu'], measuredAt: 1000, staleAfterMs: 30_000,
    cpuPercent: 99, freeMemoryBytes: 8e9, totalMemoryBytes: 16e9, eventLoopDelayMs: 20,
  },
};
afterEach(() => vi.useRealTimers());

describe('compact resource indicator', () => {
  it('shows only an icon, exposes app CPU/RAM in its tooltip and expires stale data', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const { unmount } = render(<ResourceStatus connection={connection} />);
    const button = screen.getByRole('button', { name: 'App resource usage' });
    expect(button.textContent).toBe('');
    expect(button.querySelector('.resource-status-glyph svg')).toHaveAttribute('width', '15');
    expect(button.querySelector('.resource-usage-ring')).toBeNull();
    expect(button).toHaveAttribute('title', expect.stringContaining('App CPU: 7%'));
    expect(button).toHaveAttribute('title', expect.stringContaining('System CPU: 99%'));
    expect(button).toHaveClass('resource-status--pressure');
    act(() => vi.advanceTimersByTime(30_000));
    expect(button).toHaveClass('resource-status--unknown');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('opens details and closes them before navigating to Worktree settings', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const onManageWorktrees = vi.fn();
    render(<ResourceStatus connection={connection} onManageWorktrees={onManageWorktrees} />);
    fireEvent.click(screen.getByRole('button', { name: 'App resource usage' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manage worktrees' }));
    expect(onManageWorktrees).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
