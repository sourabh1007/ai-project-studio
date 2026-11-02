import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedProcess, boundedVersion } from './bounded-execution.js';
import type { ProcessHandle } from '../provider/process-kernel/process-spawner.js';

afterEach(() => vi.useRealTimers());
describe('bounded explicit CLI execution', () => {
  it('returns completed exit codes without killing successful work', async () => {
    const kill = vi.fn();
    expect(await boundedProcess({ done: Promise.resolve(0), kill } as unknown as ProcessHandle, 100)).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
  it('requests process termination on timeout without pretending an exit code', async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const result = boundedProcess({ done: new Promise(() => {}), kill } as unknown as ProcessHandle, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBeNull();
    expect(kill).toHaveBeenCalledOnce();
  });
  it('bounds unresponsive version probes and contains rejected probes', async () => {
    vi.useFakeTimers();
    const result = boundedVersion(() => new Promise(() => {}), 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBeNull();
    expect(await boundedVersion(async () => { throw new Error('unavailable'); }, 50)).toBeNull();
    expect(await boundedVersion(async () => '1.2.3', 50)).toBe('1.2.3');
  });
});
