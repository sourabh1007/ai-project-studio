import { describe, it, expect } from 'vitest';
import {
  deriveConnectionStatus,
  connectionChanged,
  type ConnectionState,
} from './connection-status.js';

describe('deriveConnectionStatus', () => {
  it('reports healthy online when browser is online and probe is ok', () => {
    const status = deriveConnectionStatus({
      browserOnline: true,
      lastProbe: 'ok',
    });
    expect(status.state).toBe('online');
    expect(status.healthy).toBe(true);
    expect(status.title).toBe('Connected');
    expect(status.detail).toContain('reachable');
  });

  it('treats an unknown probe as healthy so the banner never flashes', () => {
    const status = deriveConnectionStatus({
      browserOnline: true,
      lastProbe: 'unknown',
    });
    expect(status.state).toBe('online');
    expect(status.healthy).toBe(true);
  });

  it('reports backend-down when online but the probe failed', () => {
    const status = deriveConnectionStatus({
      browserOnline: true,
      lastProbe: 'error',
    });
    expect(status.state).toBe('backend-down');
    expect(status.healthy).toBe(false);
    expect(status.title).toContain('service unavailable');
    expect(status.detail).toContain('actions are paused');
  });

  it('reports offline when the browser is offline regardless of probe', () => {
    for (const lastProbe of ['ok', 'error', 'unknown'] as const) {
      const status = deriveConnectionStatus({ browserOnline: false, lastProbe });
      expect(status.state).toBe('offline');
      expect(status.healthy).toBe(false);
      expect(status.title).toBe('You are offline');
      expect(status.detail).toContain('cloud actions are paused');
    }
  });
});

describe('connectionChanged', () => {
  it('is true only when the state differs', () => {
    const states: ConnectionState[] = ['online', 'backend-down', 'offline'];
    for (const a of states) {
      for (const b of states) {
        expect(connectionChanged(a, b)).toBe(a !== b);
      }
    }
  });
});
