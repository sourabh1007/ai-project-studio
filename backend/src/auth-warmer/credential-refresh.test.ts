import { describe, expect, it, vi } from 'vitest';
import { createCredentialRefresh } from './credential-refresh.js';

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('credential refresh ownership', () => {
  it('coalesces overlapping reads and publishes a single current snapshot', async () => {
    const first = pending<string>();
    const read = vi.fn(() => first.promise);
    const apply = vi.fn();
    const refresh = createCredentialRefresh({ read, apply });
    const one = refresh.refresh();
    const two = refresh.refresh();
    expect(two).toBe(one);
    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    first.resolve('current');
    await one;
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith('current');
    await refresh.refresh();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never restores a stale in-flight credential after sign-out invalidates it', async () => {
    const first = pending<string | null>();
    const apply = vi.fn();
    const refresh = createCredentialRefresh({ read: () => first.promise, apply });
    const request = refresh.refresh();
    expect(refresh.generation()).toBe(0);
    expect(refresh.invalidate()).toBe(1);
    refresh.publish(1, null);
    first.resolve('previous account');
    await request;
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(null);
    refresh.publish(0, 'old target request');
    expect(apply).toHaveBeenCalledOnce();
  });

  it.each([false, true])('serializes a fresh sign-in behind an obsolete read (old rejection=%s)', async (rejectOld) => {
    const first = pending<string>();
    const second = pending<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const apply = vi.fn();
    const refresh = createCredentialRefresh<string>({ read, apply });
    const old = refresh.refresh();
    const oldOutcome = old.catch((error: unknown) => error);
    await Promise.resolve();
    refresh.invalidate();
    const next = refresh.refresh();
    const duplicate = refresh.refresh();
    if (rejectOld) first.reject(new Error('old credential lookup failed'));
    else first.resolve('stale');
    await oldOutcome;
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
    expect(apply).not.toHaveBeenCalled();
    second.resolve('new account');
    await Promise.all([next, duplicate]);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith('new account');
  });

  it.each([false, true])('does not publish an invalidated queued refresh (old rejection=%s)', async (rejectOld) => {
    const first = pending<string>();
    const read = vi.fn(() => first.promise);
    const apply = vi.fn();
    const refresh = createCredentialRefresh({ read, apply });
    const old = refresh.refresh();
    const oldOutcome = old.catch((error: unknown) => error);
    refresh.invalidate();
    const next = refresh.refresh();
    const nextOutcome = next.catch((error: unknown) => error);
    refresh.invalidate();
    const error = new Error('obsolete lookup');
    if (rejectOld) first.reject(error);
    else first.resolve('obsolete');
    await oldOutcome;
    expect(await nextOutcome).toBe(rejectOld ? error : undefined);
    expect(read).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });

  it('propagates read and apply failures, releases admission and allows explicit retry', async () => {
    const readFailure = new Error('lookup unavailable');
    const applyFailure = new Error('publication failed');
    const read = vi.fn().mockRejectedValueOnce(readFailure).mockResolvedValue('current');
    const apply = vi.fn().mockImplementationOnce(() => { throw applyFailure; });
    const refresh = createCredentialRefresh<string>({ read, apply });
    await expect(refresh.refresh()).rejects.toBe(readFailure);
    await expect(refresh.refresh()).rejects.toBe(applyFailure);
    await expect(refresh.refresh()).resolves.toBeUndefined();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('drains existing account reads before erase and prevents new reads or publication throughout sign-out', async () => {
    const nativeRead = pending<string>();
    let snapshot: string | null = 'existing';
    const read = vi.fn(async () => 'current');
    const refresh = createCredentialRefresh<string | null>({ read, apply: (value) => { snapshot = value; } });
    const generation = refresh.generation();
    const old = refresh.run(() => nativeRead.promise);
    let drained = false;
    const logout = refresh.suspend(null).then((resume) => { drained = true; return resume; });
    expect(refresh.suspended()).toBe(true);
    expect(snapshot).toBeNull();
    await refresh.refresh();
    await expect(refresh.run(async () => 'old cached token during erase')).rejects.toThrow(/sign-out is in progress/);
    refresh.publish(refresh.generation(), 'new-generation stale token');
    expect(snapshot).toBeNull();
    await Promise.resolve();
    expect(drained).toBe(false);
    nativeRead.resolve('old account');
    await old;
    const resume = await logout;
    expect(drained).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(refresh.suspended()).toBe(true);
    refresh.publish(generation, 'pre-logout result');
    resume();
    resume();
    expect(refresh.suspended()).toBe(false);
    refresh.publish(generation + 1, 'erase-window result');
    expect(snapshot).toBeNull();
    await refresh.refresh();
    expect(snapshot).toBe('current');
  });

  it('retains the last good credential when an unavailable read rejects', async () => {
    let snapshot: string | null = 'last good';
    const refresh = createCredentialRefresh<string | null>({
      read: async () => { throw new Error('helper timed out'); }, apply: (value) => { snapshot = value; },
    });
    await expect(refresh.refresh()).rejects.toThrow('helper timed out');
    expect(snapshot).toBe('last good');
  });

  it('bounds admitted account checks and releases admission after a failed check', async () => {
    const first = pending<void>();
    const refresh = createCredentialRefresh({ read: async () => 'credential', apply: vi.fn(), maxConcurrentReads: 1 });
    const active = refresh.run(() => first.promise);
    const outcome = active.catch(() => undefined);
    await expect(refresh.run(async () => undefined)).rejects.toThrow(/operations are busy/);
    first.reject(new Error('unavailable'));
    await outcome;
    await expect(refresh.run(async () => 'retry')).resolves.toBe('retry');
  });

  it('waits for failed reads and keeps overlapping sign-outs fenced until all owners release', async () => {
    const first = pending<void>();
    const refresh = createCredentialRefresh({ read: async () => null, apply: vi.fn() });
    const active = refresh.run(() => first.promise).catch(() => undefined);
    const one = refresh.suspend(null);
    const two = refresh.suspend(null);
    first.reject(new Error('helper failed'));
    await active;
    const [resumeOne, resumeTwo] = await Promise.all([one, two]);
    resumeOne();
    expect(refresh.suspended()).toBe(true);
    resumeTwo();
    expect(refresh.suspended()).toBe(false);
  });

  it('releases the fence when clearing the published snapshot fails', async () => {
    const apply = vi.fn().mockImplementationOnce(() => { throw new Error('clear failed'); });
    const refresh = createCredentialRefresh({ read: async () => 'new', apply });
    await expect(refresh.suspend('')).rejects.toThrow('clear failed');
    expect(refresh.suspended()).toBe(false);
    await refresh.refresh();
    expect(apply).toHaveBeenLastCalledWith('new');
  });
});
