import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { killProcessTree } from './process-tree-kill.js';

describe('killProcessTree', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('always invokes the direct kill callback', () => {
    const kill = vi.fn();
    const spawnTaskkill = vi.fn();
    killProcessTree(undefined, kill, spawnTaskkill as never);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('does not spawn taskkill when no pid is available', () => {
    const spawnTaskkill = vi.fn();
    killProcessTree(undefined, vi.fn(), spawnTaskkill as never);
    expect(spawnTaskkill).not.toHaveBeenCalled();
  });

  it('also force-kills the descendant tree via taskkill on Windows when a pid is present', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const fakeChild = { on: vi.fn().mockReturnThis() } as unknown as ChildProcess;
    const spawnTaskkill = vi.fn().mockReturnValue(fakeChild);

    killProcessTree(4242, vi.fn(), spawnTaskkill as never);

    expect(spawnTaskkill).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4242', '/t', '/f'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
  });

  it('invokes the error handler without throwing when taskkill emits an error', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    let errorHandler: (() => void) | undefined;
    const fakeChild = {
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'error') {
          errorHandler = handler;
        }
        return fakeChild;
      }),
    } as unknown as ChildProcess;
    const spawnTaskkill = vi.fn().mockReturnValue(fakeChild);

    killProcessTree(4242, vi.fn(), spawnTaskkill as never);

    expect(() => errorHandler?.()).not.toThrow();
  });

  it('swallows synchronous spawn failures from taskkill', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const spawnTaskkill = vi.fn(() => {
      throw new Error('spawn failed');
    });

    expect(() =>
      killProcessTree(4242, vi.fn(), spawnTaskkill as never),
    ).not.toThrow();
    expect(spawnTaskkill).toHaveBeenCalledTimes(1);
  });

  it('does not spawn taskkill on non-Windows platforms even with a pid', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    const spawnTaskkill = vi.fn();

    killProcessTree(4242, vi.fn(), spawnTaskkill as never);

    expect(spawnTaskkill).not.toHaveBeenCalled();
  });
});
