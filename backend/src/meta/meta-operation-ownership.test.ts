import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMetaOperationOwnership, MetaOperationAdmissionError } from './meta-operation-ownership.js';
import { MetaAbortError } from './meta-runner.js';
import type { MetaOperationLease, MetaOperationScope } from './meta-operation-contract.js';

const scope = (overrides: Partial<MetaOperationScope> = {}): MetaOperationScope => ({
  operationId: 'op', featureId: 'f', automationId: null, originSessionId: null, ...overrides,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe('meta operation admission and quiescence', () => {
  it('closes feature admission synchronously and owns callback persistence until settlement without stopping unrelated work', async () => {
    const owner = createMetaOperationOwnership();
    const finish = deferred();
    let aborted = false;
    let persisted = false;
    const work = owner.own(scope(), async (lease) => {
      aborted = lease.signal.aborted;
      await finish.promise;
      persisted = true;
    });
    const quiet = owner.quiesceFeature('f', 1000);
    await expect(owner.own(scope({ operationId: 'denied' }), async () => {})).rejects.toBeInstanceOf(MetaOperationAdmissionError);
    await owner.own(scope({ operationId: 'other', featureId: 'g' }), async (lease) => expect(lease.signal.aborted).toBe(false));
    expect(aborted).toBe(true);
    expect(persisted).toBe(false);
    finish.resolve();
    await work;
    await expect(quiet).resolves.toBe(true);
    expect(persisted).toBe(true);
  });

  it.each(['origin', 'observed'])('matches %s session ownership and rejects future work for blocked IDs', async (sessionId) => {
    const owner = createMetaOperationOwnership();
    const finish = deferred();
    let signal!: AbortSignal;
    const work = owner.own(scope({ originSessionId: 'origin' }), async (lease) => {
      signal = lease.signal;
      lease.linkSession('observed');
      await finish.promise;
    });
    await Promise.resolve();
    const quiet = owner.quiesceSession(sessionId, 1000);
    expect(signal.aborted).toBe(true);
    await expect(owner.own(scope({ operationId: 'next', originSessionId: sessionId }), async () => {})).rejects.toThrow('scope is closed');
    finish.resolve(); await work; await expect(quiet).resolves.toBe(true);
  });

  it('aborts a newly linked blocked session, and ignores callbacks after settlement', async () => {
    const owner = createMetaOperationOwnership();
    await owner.quiesceSession('deleted', 0);
    let lease!: MetaOperationLease;
    await owner.own(scope(), async (value) => {
      lease = value;
      lease.linkSession('deleted');
      expect(lease.signal.aborted).toBe(true);
    });
    lease.linkSession('late');
    lease.requireTerminationConfirmation();
    expect(owner.unconfirmed()).toEqual([]);
    await expect(owner.quiesceSession('late', 0)).resolves.toBe(true);
  });

  it('quiesces only matching automations and then closes global admission', async () => {
    const owner = createMetaOperationOwnership();
    const finish = deferred();
    let matching!: AbortSignal; let unrelated!: AbortSignal;
    const a = owner.own(scope({ automationId: 'a' }), async (lease) => { matching = lease.signal; await finish.promise; });
    const b = owner.own(scope({ operationId: 'other', automationId: 'b' }), async (lease) => { unrelated = lease.signal; await finish.promise; });
    await Promise.resolve();
    const quiet = owner.quiesceAutomation('a', 1000);
    expect(matching.aborted).toBe(true); expect(unrelated.aborted).toBe(false);
    await expect(owner.own(scope({ operationId: 'new', automationId: 'a' }), async () => {})).rejects.toThrow('scope is closed');
    const all = owner.quiesceAll(1000);
    expect(unrelated.aborted).toBe(true);
    await expect(owner.own(scope({ operationId: 'closed' }), async () => {})).rejects.toThrow();
    finish.resolve(); await Promise.all([a, b]);
    await expect(quiet).resolves.toBe(true); await expect(all).resolves.toBe(true);
  });

  it('links caller cancellation and removes its listener after success or failure', async () => {
    const owner = createMetaOperationOwnership();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await owner.own(scope(), async (lease) => { controller.abort(); expect(lease.signal.aborted).toBe(true); }, controller.signal);
    await expect(owner.own(scope({ operationId: 'failed' }), async (lease) => {
      expect(lease.signal.aborted).toBe(true);
      throw new Error('provider failed');
    }, controller.signal)).rejects.toThrow('provider failed');
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('keeps unconfirmed physical ownership after callback rejection until explicit operation-specific proof arrives', async () => {
    vi.useFakeTimers();
    const owner = createMetaOperationOwnership();
    await expect(owner.own(scope(), async (lease) => {
      lease.linkSession('warm');
      lease.requireTerminationConfirmation();
      lease.requireTerminationConfirmation();
      throw new MetaAbortError({ kind: 'aborted', termination: 'unconfirmed' });
    })).rejects.toBeInstanceOf(MetaAbortError);
    expect(owner.unconfirmed()).toEqual([{ ...scope(), sessionIds: ['warm'] }]);
    await expect(owner.own(scope(), async () => {})).rejects.toThrow('scope is closed');
    const quiet = owner.quiesceSession('warm', 5);
    await vi.advanceTimersByTimeAsync(5);
    await expect(quiet).resolves.toBe(false);
    owner.confirmTermination('missing');
    owner.confirmTermination('op');
    await expect(owner.quiesceAll(100)).resolves.toBe(true);
    expect(owner.unconfirmed()).toEqual([]);
  });

  it('accepts physical proof while result persistence is still pending but continues waiting for that persistence', async () => {
    const owner = createMetaOperationOwnership();
    const finish = deferred();
    let lease!: MetaOperationLease;
    const work = owner.own(scope(), async (value) => { lease = value; await finish.promise; lease.requireTerminationConfirmation(); });
    await Promise.resolve();
    await expect(owner.own(scope(), async () => {})).rejects.toThrow();
    owner.confirmTermination('op');
    const quiet = owner.quiesceFeature('f', 1000);
    finish.resolve(); await work;
    await expect(quiet).resolves.toBe(true);
    expect(owner.unconfirmed()).toEqual([]);
  });

  it('automatically retains unconfirmed MetaAbortError ownership and does not confuse confirmed interruption with no effects', async () => {
    const owner = createMetaOperationOwnership();
    await expect(owner.own(scope(), async () => {
      throw new MetaAbortError({ kind: 'timed_out', timeoutMs: 1, termination: 'unconfirmed' });
    })).rejects.toThrow();
    expect(owner.unconfirmed()).toHaveLength(1);
    owner.confirmTermination('op');
    await owner.quiesceAll(100);
    const other = createMetaOperationOwnership();
    await expect(other.own(scope(), async () => {
      throw new MetaAbortError({ kind: 'aborted', termination: 'confirmed' });
    })).rejects.toThrow();
    await expect(other.quiesceAll(0)).resolves.toBe(true);
  });

  it('validates timeout before closing admission', async () => {
    const owner = createMetaOperationOwnership();
    expect(() => owner.quiesceFeature('f', -1)).toThrow(RangeError);
    expect(() => owner.quiesceAll(Infinity)).toThrow(RangeError);
    await owner.own(scope(), async () => {});
  });

  it('releases logical tracking even when failure classification itself throws', async () => {
    const owner = createMetaOperationOwnership();
    const error = new MetaAbortError({ kind: 'aborted', termination: 'confirmed' });
    Object.defineProperty(error, 'termination', { get: () => { throw new Error('classification failed'); } });
    await expect(owner.own(scope(), async () => { throw error; })).rejects.toThrow('classification failed');
    await expect(owner.quiesceAll(0)).resolves.toBe(true);
  });
});
