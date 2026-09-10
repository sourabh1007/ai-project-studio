import { describe, expect, it, vi } from 'vitest';
import { createProcessAdmission, ProcessAdmissionError } from './process-admission.js';
import { PROCESS_ADMISSION_NAMESPACE, processAdmissionConfigSchema, processAdmissionDefaults } from './process-admission-config.js';

describe('shared headless process admission', () => {
  const config = { maxProcesses: 2, maxWarmProcesses: 1, maxQueued: 2 };

  it('validates bounded defaults and always reserves cold capacity', () => {
    expect(PROCESS_ADMISSION_NAMESPACE).toBe('processAdmission');
    expect(processAdmissionConfigSchema.parse(processAdmissionDefaults)).toEqual(processAdmissionDefaults);
    for (const change of [{ maxProcesses: 0 }, { maxWarmProcesses: 2 }, { maxQueued: -1 }, { maxQueued: 1.5 }]) {
      expect(() => createProcessAdmission({ ...config, ...change })).toThrow();
    }
  });

  it('counts native reservations, reserves cold headroom, and releases each permit only once', async () => {
    const budget = createProcessAdmission(config);
    expect(budget.limits()).toEqual(config);
    const limits = budget.limits();
    limits.maxProcesses = 1;
    expect(budget.limits()).toEqual(config);
    expect(budget.canAcquireWarm()).toBe(true);
    const warm = budget.tryAcquireWarm()!;
    expect(budget.canAcquireWarm()).toBe(false);
    expect(budget.tryAcquireWarm()).toBeNull();
    const cold = await budget.acquireCold();
    expect(budget.stats()).toEqual({ processes: 2, warmProcesses: 1, queued: 0, closed: false });
    cold.release(); cold.release();
    warm.release();
    expect(budget.stats().processes).toBe(0);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(budget.acquireCold(cancelled.signal)).rejects.toMatchObject({ reason: 'cancelled' });
  });

  it('shares queue slots across warm waiters and FIFO cold acquisition, with cancellation cleanup', async () => {
    const budget = createProcessAdmission(config);
    const first = await budget.acquireCold(); const second = await budget.acquireCold();
    const external = budget.reserveQueue(() => {});
    const controller = new AbortController();
    const pending = budget.acquireCold(controller.signal);
    await expect(budget.acquireCold()).rejects.toMatchObject({ reason: 'queue-full' });
    expect(budget.tryAcquireWarm()).toBeNull();
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ProcessAdmissionError);
    expect(budget.stats().queued).toBe(1);
    external.release();
    const order: number[] = [];
    const a = budget.acquireCold().then((permit) => { order.push(1); return permit; });
    const b = budget.acquireCold().then((permit) => { order.push(2); return permit; });
    first.release();
    const granted = await a;
    expect(order).toEqual([1]);
    expect(budget.stats().processes).toBe(2);
    second.release();
    const next = await b;
    expect(order).toEqual([1, 2]);
    granted.release(); next.release();
    expect(budget.stats().queued).toBe(0);
  });

  it('keeps queue identities distinct and ignores a late abort after native admission', async () => {
    const budget = createProcessAdmission(config);
    const callback = vi.fn();
    const one = budget.reserveQueue(callback); const two = budget.reserveQueue(callback);
    expect(budget.stats().queued).toBe(2);
    one.release(); two.release();
    const first = await budget.acquireCold(); const second = await budget.acquireCold();
    const controller = new AbortController();
    const listener = vi.spyOn(controller.signal, 'addEventListener');
    const grantedPromise = budget.acquireCold(controller.signal);
    const late = listener.mock.calls[0][1];
    first.release();
    const granted = await grantedPromise;
    const pending = budget.acquireCold();
    if (typeof late === 'function') late.call(controller.signal, new Event('abort'));
    expect(budget.stats()).toMatchObject({ processes: 2, queued: 1 });
    granted.release();
    const last = await pending;
    second.release(); last.release();
  });

  it('prioritizes cold waiters over warm prefill on native exit', async () => {
    const budget = createProcessAdmission(config);
    const warm = budget.tryAcquireWarm()!; const active = await budget.acquireCold();
    const waiting = budget.acquireCold();
    let stolen = false;
    const detach = budget.onCapacityChange(() => { stolen = budget.tryAcquireWarm() !== null; });
    warm.release();
    const cold = await waiting;
    expect(stolen).toBe(false);
    detach(); active.release(); cold.release();
  });

  it('downsizes without overadmission, retires warm owners once, and waits for real release', async () => {
    const budget = createProcessAdmission({ ...config, maxProcesses: 4, maxWarmProcesses: 3 });
    const warm = budget.tryAcquireWarm()!;
    const lateBound = budget.tryAcquireWarm()!;
    const cold = await budget.acquireCold();
    const retire = vi.fn(); warm.onRetire(retire);
    budget.reconfigure({ maxProcesses: 1, maxWarmProcesses: 0, maxQueued: 2 });
    expect(retire).toHaveBeenCalledTimes(1);
    const lateRetire = vi.fn(); lateBound.onRetire(lateRetire);
    expect(lateRetire).toHaveBeenCalledTimes(1);
    budget.reconfigure({ maxProcesses: 1, maxWarmProcesses: 0, maxQueued: 2 });
    expect(retire).toHaveBeenCalledTimes(1);
    expect(budget.tryAcquireWarm()).toBeNull();
    const pending = budget.acquireCold();
    expect(budget.stats()).toMatchObject({ processes: 3, queued: 1 });
    warm.release(); lateBound.release();
    expect(budget.stats()).toMatchObject({ processes: 1, queued: 1 });
    cold.release();
    const permit = await pending;
    expect(budget.stats()).toMatchObject({ processes: 1, queued: 0 });
    permit.release();
    lateBound.onRetire(() => { throw new Error('released reservation cannot be retired'); });
  });

  it('raises limits safely and retains existing queues when their configured limit shrinks', async () => {
    const budget = createProcessAdmission({ maxProcesses: 1, maxWarmProcesses: 0, maxQueued: 2 });
    const active = await budget.acquireCold();
    const a = budget.acquireCold(); const b = budget.acquireCold();
    budget.reconfigure({ maxProcesses: 2, maxWarmProcesses: 0, maxQueued: 0 });
    const granted = await a;
    await expect(budget.acquireCold()).rejects.toMatchObject({ reason: 'queue-full' });
    granted.release(); const last = await b;
    active.release(); last.release();
    expect(() => budget.reconfigure({ ...config, maxProcesses: 0 })).toThrow();
    expect(budget.stats().processes).toBe(0);
  });

  it('closes all queued ownership without freeing live processes or reopening after reconfiguration', async () => {
    const budget = createProcessAdmission(config);
    const warm = budget.tryAcquireWarm()!; const active = await budget.acquireCold();
    const pending = budget.acquireCold();
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'closed' });
    const closed = vi.fn();
    budget.reserveQueue(closed);
    budget.close(); budget.close();
    await rejected;
    expect(closed).toHaveBeenCalledTimes(1);
    expect(budget.stats()).toEqual({ processes: 2, warmProcesses: 1, queued: 0, closed: true });
    expect(budget.tryAcquireWarm()).toBeNull();
    await expect(budget.acquireCold()).rejects.toMatchObject({ reason: 'closed' });
    expect(() => budget.reserveQueue(() => {})).toThrow('shutting down');
    budget.reconfigure(config);
    active.release(); warm.release();
    expect(budget.stats().processes).toBe(0);
  });
});
