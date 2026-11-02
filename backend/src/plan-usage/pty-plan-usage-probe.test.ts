import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPtyPlanUsageProbe } from './pty-plan-usage-probe.js';
import { createProcessAdmission } from '../kernel/process-admission.js';
import { processAdmissionDefaults } from '../kernel/process-admission-config.js';
import type { PtyProcess } from '../terminal/pty-contract.js';

function fixture() {
  vi.useFakeTimers();
  const admission = createProcessAdmission(processAdmissionDefaults);
  let data: (text: string) => void = () => {};
  let exit: (code: number | null) => void = () => {};
  const release = vi.fn();
  const proc: PtyProcess = {
    write: vi.fn(() => data('Plan 2% used 25,000 / 1,000,000 AIC')),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (listener) => { data = listener; },
    onExit: (listener) => { exit = listener; },
  };
  const spawn = vi.fn(() => proc);
  const resolveCommand = vi.fn(() => ({ command: 'configured-cli', args: ['configured-flag'] }));
  const probe = createPtyPlanUsageProbe({
    spawner: { spawn }, admission, env: {}, resolveCommand,
    acquireExecution: () => ({ release }),
    usageCommand: () => '/account-usage',
    bootMs: 1, timeoutMs: 1000, retryMs: 4000,
  });
  return { admission, proc, spawn, resolveCommand, probe, release, exit: () => exit(0) };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('managed quota CLI probe', () => {
  it('uses configured commands and retains ownership until native exit, not kill', async () => {
    const f = fixture();
    const capture = f.probe.capture();
    expect(f.probe.isCapturing()).toBe(true);
    expect(() => f.probe.stop()).toThrow('still capturing');
    await vi.advanceTimersByTimeAsync(300);
    expect(await capture).toContain('AIC');
    expect(f.proc.write).toHaveBeenCalledWith('/account-usage\r');
    expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ command: 'configured-cli' }));
    expect(f.probe.isCapturing()).toBe(false);
    f.probe.stop();
    expect(f.proc.kill).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.admission.stats().processes).toBe(1);
    f.exit();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.admission.stats().processes).toBe(0);
    expect(await f.probe.capture()).toBeNull();
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it('releases a pre-spawn reservation when command resolution fails', async () => {
    const f = fixture();
    f.resolveCommand.mockImplementation(() => { throw new Error('invalid command'); });
    await expect(f.probe.capture()).rejects.toThrow('invalid command');
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.admission.stats().processes).toBe(0);
    expect(f.probe.isCapturing()).toBe(false);
  });

  it('releases execution ownership when admission is closed', async () => {
    const f = fixture();
    f.admission.close();
    expect(await f.probe.capture()).toBeNull();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('shutdown kills a booting probe but waits for native exit to release its lease', async () => {
    const f = fixture();
    const capture = f.probe.capture();
    await vi.advanceTimersByTimeAsync(0);
    f.probe.shutdown();
    expect(f.proc.kill).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
    f.exit();
    await vi.advanceTimersByTimeAsync(2);
    expect(await capture).toBeNull();
    expect(f.release).toHaveBeenCalledOnce();
  });
});
