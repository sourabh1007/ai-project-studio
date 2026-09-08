import { describe, expect, it, vi } from 'vitest';
import { createMetaOperationShutdown } from './meta-operation-shutdown.js';

function fixture() {
  const ownership = {
    quiesceAll: vi.fn(async () => true),
    unconfirmed: () => [{
      operationId: 'operation', featureId: 'feature', automationId: null,
      originSessionId: null, sessionIds: ['session'],
    }],
    confirmTermination: vi.fn(),
  };
  const reportError = vi.fn();
  return { ownership, reportError, shutdown: createMetaOperationShutdown({
    ownership, timeoutMs: 100, reportError,
  }) };
}

describe('meta operation shutdown', () => {
  it('closes admission but does not invent physical proof while requesting cancellation', async () => {
    const { ownership, shutdown } = fixture();
    shutdown.abort();
    expect(ownership.quiesceAll).toHaveBeenCalledWith(100);
    expect(ownership.confirmTermination).not.toHaveBeenCalled();
    await shutdown.settleAfterPhysicalDrain();
    expect(ownership.confirmTermination).toHaveBeenCalledWith('operation');
    expect(ownership.quiesceAll).toHaveBeenCalledTimes(2);
  });

  it('requires admission closure before accepting global physical-drain proof', async () => {
    await expect(fixture().shutdown.settleAfterPhysicalDrain()).rejects.toThrow('admission');
  });

  it('requires fresh confirmation even if the first bounded wait expired', async () => {
    const { ownership, shutdown } = fixture();
    ownership.quiesceAll.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    shutdown.abort();
    await expect(shutdown.settleAfterPhysicalDrain()).rejects.toMatchObject({ kind: 'conflict' });
    await expect(shutdown.settleAfterPhysicalDrain()).resolves.toBeUndefined();
  });

  it('reports a rejected initial wait and does not poison subsequent reconciliation retries', async () => {
    const { ownership, shutdown, reportError } = fixture();
    const error = new Error('quiescence failed');
    ownership.quiesceAll.mockRejectedValueOnce(error);
    shutdown.abort();
    await expect(shutdown.settleAfterPhysicalDrain()).rejects.toBe(error);
    expect(reportError).toHaveBeenCalledWith(error);
    await expect(shutdown.settleAfterPhysicalDrain()).resolves.toBeUndefined();
  });
});
