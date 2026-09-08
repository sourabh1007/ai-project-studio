import { describe, expect, it, vi } from 'vitest';
import { createMetaOperationPhysicalOwnership, registerUnstartedMetaAttempt } from './meta-operation-physical-ownership.js';
import { createMetaOperationOwnership } from './meta-operation-ownership.js';
import type { MetaOperationPhysicalOwner, MetaOperationPhysicalProof, MetaOperationPhysicalRegistration } from './meta-operation-contract.js';
import { MetaAbortError } from './meta-runner.js';

function attempt(ownerId: string) {
  let finish!: (proof: Exclude<MetaOperationPhysicalProof, 'unconfirmed'>) => void;
  let fail!: (error: Error) => void;
  const settled = new Promise<Exclude<MetaOperationPhysicalProof, 'unconfirmed'>>((resolve, reject) => { finish = resolve; fail = reject; });
  const owner = { ownerId, settled, quiesce: vi.fn(async () => 'unconfirmed' as const) } satisfies MetaOperationPhysicalOwner;
  return { owner, finish, fail };
}
const scope = { operationId: 'op', featureId: 'f', automationId: 'a', originSessionId: 'origin' };

describe('physical operation ownership', () => {
  it('registers only an attributed preflight completion without changing other attempts', async () => {
    const physical = { register: vi.fn<MetaOperationPhysicalRegistration['register']>(), newOwnerId: () => 'preflight' };
    registerUnstartedMetaAttempt(undefined, 'op');
    registerUnstartedMetaAttempt(physical, undefined);
    expect(physical.register).not.toHaveBeenCalled();
    registerUnstartedMetaAttempt(physical, 'op');
    expect(physical.register).toHaveBeenCalledTimes(1);
    const [operationId, owner] = physical.register.mock.calls[0];
    expect(operationId).toBe('op');
    expect(owner.ownerId).toBe('preflight');
    expect(await owner.settled).toBe('not-started');
    expect(await owner.quiesce(0)).toBe('not-started');
  });

  it('aggregates every fallback attempt, preserves timed-out work, and forgets only proven sealed completion', async () => {
    const physical = createMetaOperationPhysicalOwnership({ newOwnerId: () => 'unique' });
    expect(physical.newOwnerId()).toBe('unique');
    expect(await physical.quiesce('missing', 0)).toBe('unknown');
    expect(() => physical.expect('missing')).toThrow();
    expect(() => physical.seal('missing')).toThrow();
    physical.begin('op'); physical.expect('op');
    expect(() => physical.begin('op')).toThrow();
    const warm = attempt('warm'); const cold = attempt('cold');
    physical.register('op', warm.owner); physical.register('op', cold.owner);
    expect(() => physical.register('op', cold.owner)).toThrow();
    warm.finish('released');
    const sealed = physical.seal('op');
    expect(() => physical.register('op', attempt('late').owner)).toThrow();
    expect(await physical.quiesce('op', 0)).toBe('unconfirmed');
    expect(cold.owner.quiesce).toHaveBeenCalled();
    cold.finish('exited');
    await expect(sealed).resolves.toBe('confirmed');
    expect(await physical.quiesce('op', 0)).toBe('unknown');
    physical.begin('op');
    await expect(physical.seal('op')).resolves.toBe('confirmed');
  });

  it('distinguishes certified pre-dispatch completion from missing ownership and rejects late admission', async () => {
    const physical = createMetaOperationPhysicalOwnership({ newOwnerId: () => 'id' });
    physical.begin('missing-owner'); physical.expect('missing-owner');
    expect(await physical.seal('missing-owner')).toBe('unknown');
    expect(await physical.quiesce('missing-owner', 0)).toBe('unknown');
    expect(() => physical.register('missing-owner', attempt('late').owner)).toThrow();
    physical.forget('missing-owner'); physical.forget('absent');
    physical.begin('closed-before-enqueue'); physical.expect('closed-before-enqueue');
    expect(await physical.quiesce('closed-before-enqueue', 0)).toBe('unknown');
    expect(() => physical.register('closed-before-enqueue', attempt('never-enqueued').owner)).toThrow();
    expect(await physical.seal('closed-before-enqueue')).toBe('confirmed');
    await expect(physical.quiesce('absent', -1)).rejects.toThrow(RangeError);
  });

  it('never treats rejected native completion or failed stop requests as exit', async () => {
    const physical = createMetaOperationPhysicalOwnership({ newOwnerId: () => 'id' });
    physical.begin('op'); physical.expect('op');
    const native = attempt('native');
    native.owner.quiesce.mockRejectedValue(new Error('kill failed'));
    physical.register('op', native.owner);
    native.fail(new Error('completion unavailable'));
    const sealed = physical.seal('op');
    expect(await physical.quiesce('op', 0)).toBe('unconfirmed');
    physical.forget('op');
    await expect(sealed).resolves.toBe('confirmed');
  });

  it('does not retain completed attempt histories or let old callbacks erase newer admissions', async () => {
    const physical = createMetaOperationPhysicalOwnership({ newOwnerId: () => 'id' });
    for (let index = 0; index < 25; index += 1) {
      physical.begin('op'); physical.expect('op');
      const native = attempt('native');
      physical.register('op', native.owner);
      const sealed = physical.seal('op');
      physical.forget('op');
      physical.begin('op'); physical.expect('op');
      native.finish('exited');
      await sealed;
      await Promise.resolve();
      expect(await physical.seal('op')).toBe('unknown');
      physical.forget('op');
    }
  });

  it.each(['feature', 'session', 'automation'] as const)('converges scoped %s cancellation on actual native proof while retaining persistence ownership', async (kind) => {
    const physical = createMetaOperationPhysicalOwnership({ newOwnerId: () => 'id' });
    const ownership = createMetaOperationOwnership({ physical });
    const native = attempt('native');
    let fail!: (error: Error) => void;
    const running = ownership.own(scope, async (lease) => {
      lease.expectPhysicalOwnership(); lease.linkSession('observed');
      physical.register('op', native.owner);
      await new Promise<void>((_, reject) => { fail = reject; });
    });
    await Promise.resolve();
    const rejection = expect(running).rejects.toBeInstanceOf(MetaAbortError);
    fail(new MetaAbortError({ kind: 'aborted', termination: 'unconfirmed' }));
    await rejection;
    const quiesce = () => kind === 'feature' ? ownership.quiesceFeature('f', 0)
      : kind === 'session' ? ownership.quiesceSession('observed', 0) : ownership.quiesceAutomation('a', 0);
    expect(await quiesce()).toBe(false);
    expect(native.owner.quiesce).toHaveBeenCalled();
    native.finish('exited');
    await expect(kind === 'feature' ? ownership.quiesceFeature('f', 100)
      : kind === 'session' ? ownership.quiesceSession('origin', 100) : ownership.quiesceAutomation('a', 100)).resolves.toBe(true);
  });

  it('holds missing expected ownership, but preflight cancellation needs no invented native owner', async () => {
    const physical = createMetaOperationPhysicalOwnership({ newOwnerId: () => 'id' });
    const ownership = createMetaOperationOwnership({ physical });
    await ownership.own(scope, async (lease) => { lease.expectPhysicalOwnership(); });
    expect(await ownership.quiesceFeature('f', 0)).toBe(false);
    ownership.confirmTermination('op');
    expect(await ownership.quiesceAll(0)).toBe(true);
    const preflight = createMetaOperationOwnership({ physical });
    await expect(preflight.own({ ...scope, operationId: 'preflight' }, async () => {
      throw new MetaAbortError({ kind: 'aborted', termination: 'not-started' });
    })).rejects.toThrow();
    expect(await preflight.quiesceAll(100)).toBe(true);
  });

  it('keeps error/result persistence owned after independent physical proof arrives', async () => {
    const physical = createMetaOperationPhysicalOwnership({ newOwnerId: () => 'id' });
    const ownership = createMetaOperationOwnership({ physical });
    let persist!: () => void;
    const running = ownership.own(scope, async (lease) => {
      lease.expectPhysicalOwnership();
      await new Promise<void>((resolve) => { persist = resolve; });
    });
    await Promise.resolve();
    ownership.confirmTermination('op');
    expect(await ownership.quiesceFeature('f', 0)).toBe(false);
    persist(); await running;
    expect(await ownership.quiesceFeature('f', 100)).toBe(true);
    expect(await physical.quiesce('op', 0)).toBe('unknown');
    physical.begin('op');
    expect(await physical.seal('op')).toBe('confirmed');
  });
});
