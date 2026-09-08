import { render, screen } from '@testing-library/react';
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
});
