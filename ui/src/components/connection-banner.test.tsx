import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from '../lib/connection-status.js';
import { deriveConnectionStatus } from '../lib/connection-status.js';
import { ConnectionBanner } from './connection-banner.js';

const probe = vi.hoisted(() => vi.fn<() => ConnectionStatus>());
vi.mock('../hooks/use-connection-status.js', () => ({ useConnectionStatus: probe }));

beforeEach(() => {
  probe.mockReturnValue(deriveConnectionStatus({ browserOnline: true, lastProbe: 'ok' }));
});

describe('connection banner', () => {
  it('hides only when both transport and live history are healthy', () => {
    render(<ConnectionBanner />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps missing-event history visible even when the health endpoint is responding', () => {
    render(<ConnectionBanner liveInterrupted />);
    expect(screen.getByRole('status')).toHaveTextContent('Live updates interrupted');
    expect(screen.getByRole('status')).toHaveTextContent('Saved totals and results are preserved');
  });

  it('explains bounded live history without implying stored usage was discarded', () => {
    render(<ConnectionBanner liveHistoryLimited />);
    expect(screen.getByRole('status')).toHaveTextContent('Live history limited');
    expect(screen.getByRole('status')).toHaveTextContent('Totals and full results remain in saved data');
  });

  it('prioritizes actual connectivity failures over live cache warnings', () => {
    probe.mockReturnValue(deriveConnectionStatus({ browserOnline: false, lastProbe: 'error' }));
    render(<ConnectionBanner liveInterrupted />);
    expect(screen.getByRole('status')).toHaveTextContent('You are offline');
    expect(screen.getByRole('status')).not.toHaveTextContent('Live updates interrupted');
  });

  it('offers a restart when the backend stopped for good', async () => {
    const relaunch = vi.fn().mockResolvedValue(true);
    (window as unknown as { desktop: unknown }).desktop = { relaunch };
    probe.mockReturnValue(deriveConnectionStatus({
      browserOnline: true, lastProbe: 'error', backendUnavailable: true,
    }));
    render(<ConnectionBanner />);
    // Terminal, so it must interrupt rather than settle into the polite queue.
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('Studio service stopped');
    await act(async () => { screen.getByRole('button', { name: 'Restart app' }).click(); });
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(banner).not.toHaveTextContent('Restarting failed');
  });

  it('says so when the restart itself does not take', async () => {
    const relaunch = vi.fn().mockResolvedValue(false);
    (window as unknown as { desktop: unknown }).desktop = { relaunch };
    probe.mockReturnValue(deriveConnectionStatus({
      browserOnline: true, lastProbe: 'error', backendUnavailable: true,
    }));
    render(<ConnectionBanner />);
    await act(async () => { screen.getByRole('button', { name: 'Restart app' }).click(); });
    expect(screen.getByRole('alert')).toHaveTextContent('close and reopen the app');
  });

  it('does not offer a restart for a backend that may still recover', () => {
    probe.mockReturnValue(deriveConnectionStatus({ browserOnline: true, lastProbe: 'error' }));
    render(<ConnectionBanner />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
