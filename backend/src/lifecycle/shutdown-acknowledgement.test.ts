import { describe, expect, it, vi } from 'vitest';
import { acknowledgeDesktopShutdown, isDesktopShutdownRequest } from './shutdown-acknowledgement.js';

describe('desktop shutdown acknowledgement', () => {
  it('accepts only a request for the current desktop generation', () => {
    const request = { type: 'shutdown-request', nonce: 'current' };
    expect(isDesktopShutdownRequest(request, 'current')).toBe(true);
    expect(isDesktopShutdownRequest(request, undefined)).toBe(false);
    expect(isDesktopShutdownRequest(request, '')).toBe(false);
    for (const message of [null, undefined, 'request', {}, { type: 'other' },
      { type: 'shutdown-request' }, { ...request, nonce: 'old' }]) {
      expect(isDesktopShutdownRequest(message, 'current')).toBe(false);
    }
  });

  it('does not send an acknowledgement for a standalone backend', async () => {
    const send = vi.fn();
    await acknowledgeDesktopShutdown(undefined, send);
    expect(send).not.toHaveBeenCalled();
  });

  it('requires the generation nonce and IPC channel together', async () => {
    await expect(acknowledgeDesktopShutdown('nonce', undefined))
      .rejects.toMatchObject({ kind: 'config' });
    await expect(acknowledgeDesktopShutdown(' ', vi.fn()))
      .rejects.toMatchObject({ kind: 'config' });
  });

  it('waits for the send callback rather than treating backpressure as failure or delivery', async () => {
    let finish!: (error: Error | null) => void;
    let acknowledged = false;
    const send = vi.fn((_message, callback) => {
      finish = callback;
      return false;
    });
    const pending = acknowledgeDesktopShutdown('generation-nonce', send)
      .then(() => { acknowledged = true; });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(send.mock.calls[0][0]).toEqual({
      type: 'shutdown-complete', nonce: 'generation-nonce',
    });
    finish(null);
    await pending;
    expect(acknowledged).toBe(true);
  });

  it('propagates asynchronous IPC failure and synchronous sender failure', async () => {
    const failure = new Error('IPC disconnected');
    await expect(acknowledgeDesktopShutdown('nonce', (_message, callback) => {
      callback(failure);
    })).rejects.toBe(failure);
    await expect(acknowledgeDesktopShutdown('nonce', () => { throw failure; }))
      .rejects.toBe(failure);
  });
});
