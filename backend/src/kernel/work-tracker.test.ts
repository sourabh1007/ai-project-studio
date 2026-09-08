import { describe, expect, it } from 'vitest';
import { createWorkTracker } from './work-tracker.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('work-tracker', () => {
  it('reserves ownership before dispatch and releases on success', async () => {
    const tracker = createWorkTracker<string>();
    let entered = false;
    const owned = tracker.own('a', async () => { entered = true; return 42; });
    expect(entered).toBe(false);
    expect([...tracker.keys()]).toEqual(['a']);
    const idle = tracker.waitForIdle(100);
    expect(await owned).toBe(42);
    expect(await idle).toBe(true);
    expect([...tracker.keys()]).toEqual([]);
    expect(await tracker.waitForIdle(0)).toBe(true);
  });

  it('does not report idle on a timeout or an unrelated settlement', async () => {
    const tracker = createWorkTracker<string>();
    const a = deferred<void>();
    const b = deferred<void>();
    const ownedA = tracker.own('a', () => a.promise);
    const ownedB = tracker.own('b', () => b.promise);
    const idle = tracker.waitForIdle(1, (key) => key === 'b');
    a.resolve();
    await ownedA;
    expect(await idle).toBe(false);
    expect([...tracker.keys()]).toEqual(['b']);
    expect(await tracker.waitForIdle(0, (key) => key === 'a')).toBe(true);
    const nextIdle = tracker.waitForIdle(100);
    b.resolve();
    await ownedB;
    expect(await nextIdle).toBe(true);
  });

  it('waits for nested work admitted before its parent settles', async () => {
    const tracker = createWorkTracker<string>();
    const child = deferred<void>();
    await tracker.own('a', async () => {
      void tracker.own('a', () => child.promise);
    });
    expect(await tracker.waitForIdle(1)).toBe(false);
    const idle = tracker.waitForIdle(100);
    child.resolve();
    expect(await idle).toBe(true);
  });

  it('releases rejected and synchronously throwing work without replacing its error', async () => {
    const tracker = createWorkTracker<string>();
    const error = new Error('failed');
    const owned = tracker.own('a', () => { throw error; });
    const idle = tracker.waitForIdle(100);
    await expect(owned).rejects.toBe(error);
    expect(await idle).toBe(true);
  });

  it.each([-1, NaN, Infinity])('rejects an invalid timeout %s', (timeout) => {
    expect(() => createWorkTracker().waitForIdle(timeout)).toThrow(RangeError);
  });
});
