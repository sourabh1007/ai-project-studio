import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { killProcessTree } from './process-tree-kill.js';

describe('killProcessTree', () => {
  it('keeps an Agency root alive until taskkill has located and stopped its descendants', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const handlers = new Map<string, () => void>();
    const child = { on(event: string, handler: () => void) { handlers.set(event, handler); return child; } };
    const kill = vi.fn();
    killProcessTree(4242, kill, vi.fn(() => child) as never, true);
    expect(kill).not.toHaveBeenCalled();
    handlers.get('close')!();
    handlers.get('error')!();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('falls back to the direct signal on tree-first failures and non-Windows platforms', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const kill = vi.fn();
    killProcessTree(4242, kill, vi.fn(() => { throw new Error('spawn failed'); }) as never, true);
    expect(kill).toHaveBeenCalledTimes(1);
    killProcessTree(undefined, kill, vi.fn() as never, true);
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    killProcessTree(4242, kill, vi.fn() as never, true);
    expect(kill).toHaveBeenCalledTimes(3);
  });

  it('does not crash the owner if an asynchronous direct fallback fails', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    let close!: () => void;
    const child = { on(event: string, handler: () => void) { if (event === 'close') close = handler; return child; } };
    killProcessTree(4242, () => { throw new Error('signal failed'); }, vi.fn(() => child) as never, true);
    expect(() => close()).not.toThrow();
  });
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
