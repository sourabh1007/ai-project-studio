import { describe, expect, it, vi } from 'vitest';
import {
  healErrorText,
  healTerminalLaunch,
  launchWithSelfHealing,
  type HealFsPort,
  type HealLevel,
} from './terminal-launch-heal.js';

function fakeFs(dirs: Set<string>, opts: { canCreate?: boolean } = {}): HealFsPort {
  return {
    dirExists: (p) => dirs.has(p),
    ensureDir: (p) => {
      if (opts.canCreate === false) {
        return false;
      }
      dirs.add(p);
      return true;
    },
  };
}

function collector() {
  const lines: Array<{ level: HealLevel; message: string }> = [];
  return {
    lines,
    emit: (level: HealLevel, message: string) => lines.push({ level, message }),
  };
}

describe('healErrorText', () => {
  it('renders Error, string, and unknown values', () => {
    expect(healErrorText(new Error('boom'))).toBe('boom');
    expect(healErrorText('raw')).toBe('raw');
    expect(healErrorText(267)).toBe('267');
  });
});

describe('healTerminalLaunch', () => {
  it('returns null and stays silent when the working directory exists', () => {
    const { lines, emit } = collector();
    const decision = healTerminalLaunch({
      cwd: 'C:/repo',
      fallbackCwd: 'C:/work',
      fs: fakeFs(new Set(['C:/repo', 'C:/work'])),
      emit,
    });
    expect(decision).toBeNull();
    expect(lines).toHaveLength(0);
  });

  it('falls back to the workspace root when a repo checkout is missing', () => {
    const { lines, emit } = collector();
    const decision = healTerminalLaunch({
      cwd: 'C:/repo',
      fallbackCwd: 'C:/work',
      fs: fakeFs(new Set(['C:/work'])),
      emit,
    });
    expect(decision).toEqual({ cwd: 'C:/work' });
    expect(lines[0].level).toBe('info');
    expect(lines.at(-1)?.message).toContain('C:/work');
  });

  it('recreates a missing repo-less scratch directory in place', () => {
    const dirs = new Set<string>();
    const { lines, emit } = collector();
    const decision = healTerminalLaunch({
      cwd: 'C:/work',
      fallbackCwd: 'C:/work',
      fs: fakeFs(dirs),
      emit,
    });
    expect(decision).toEqual({ cwd: 'C:/work' });
    expect(dirs.has('C:/work')).toBe(true);
    expect(lines.some((l) => l.level === 'success')).toBe(true);
  });

  it('reports an error when the directory cannot be restored', () => {
    const { lines, emit } = collector();
    const decision = healTerminalLaunch({
      cwd: 'C:/work',
      fallbackCwd: 'C:/work',
      fs: fakeFs(new Set(), { canCreate: false }),
      emit,
    });
    expect(decision).toBeNull();
    expect(lines.at(-1)?.level).toBe('error');
  });
});

describe('launchWithSelfHealing', () => {
  it('returns immediately when the first launch succeeds', async () => {
    const { emit, lines } = collector();
    const launch = vi.fn().mockResolvedValue('terminal');
    const result = await launchWithSelfHealing({
      launch,
      resolvedCwd: 'C:/repo',
      fallbackCwd: 'C:/work',
      fs: fakeFs(new Set(['C:/repo'])),
      emit,
    });
    expect(result).toBe('terminal');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith('C:/repo');
    expect(lines).toHaveLength(0);
  });

  it('heals a missing directory and retries in the repaired directory', async () => {
    const { emit, lines } = collector();
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error('Cannot create process, error code: 267'))
      .mockResolvedValueOnce('terminal');
    const result = await launchWithSelfHealing({
      launch,
      resolvedCwd: 'C:/repo',
      fallbackCwd: 'C:/work',
      fs: fakeFs(new Set(['C:/work'])),
      emit,
    });
    expect(result).toBe('terminal');
    expect(launch).toHaveBeenNthCalledWith(1, 'C:/repo');
    expect(launch).toHaveBeenNthCalledWith(2, 'C:/work');
    expect(lines.some((l) => l.message.includes('no longer exists'))).toBe(true);
  });

  it('uses the resolved cwd fallback when none is provided', async () => {
    const { emit } = collector();
    const launch = vi.fn().mockResolvedValue('terminal');
    await launchWithSelfHealing({
      launch,
      resolvedCwd: undefined,
      fallbackCwd: 'C:/work',
      fs: fakeFs(new Set(['C:/work'])),
      emit,
    });
    expect(launch).toHaveBeenCalledWith('C:/work');
  });

  it('diagnoses and rethrows when the failure is not a directory problem', async () => {
    const { emit, lines } = collector();
    const error = new Error('command not found: copilot');
    const launch = vi.fn().mockRejectedValue(error);
    const diagnose = vi.fn().mockResolvedValue('The Copilot CLI is not installed.');
    await expect(
      launchWithSelfHealing({
        launch,
        resolvedCwd: 'C:/repo',
        fallbackCwd: 'C:/work',
        fs: fakeFs(new Set(['C:/repo', 'C:/work'])),
        emit,
        diagnose,
      }),
    ).rejects.toBe(error);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(diagnose).toHaveBeenCalledWith('command not found: copilot');
    expect(lines.some((l) => l.message.includes('not installed'))).toBe(true);
    expect(lines.at(-1)).toEqual({
      level: 'error',
      message: 'Terminal launch failed: command not found: copilot',
    });
  });

  it('diagnoses and rethrows when the healed retry also fails', async () => {
    const { emit, lines } = collector();
    const retryError = new Error('still broken');
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error('error code: 267'))
      .mockRejectedValueOnce(retryError);
    const diagnose = vi.fn().mockResolvedValue('Directory permissions are wrong.');
    await expect(
      launchWithSelfHealing({
        launch,
        resolvedCwd: 'C:/repo',
        fallbackCwd: 'C:/work',
        fs: fakeFs(new Set(['C:/work'])),
        emit,
        diagnose,
      }),
    ).rejects.toBe(retryError);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(lines.at(-1)?.message).toContain('still broken');
  });

  it('tolerates a diagnosis that throws', async () => {
    const { emit, lines } = collector();
    const error = new Error('opaque failure');
    const launch = vi.fn().mockRejectedValue(error);
    const diagnose = vi.fn().mockRejectedValue(new Error('meta unavailable'));
    await expect(
      launchWithSelfHealing({
        launch,
        resolvedCwd: 'C:/repo',
        fallbackCwd: 'C:/work',
        fs: fakeFs(new Set(['C:/repo', 'C:/work'])),
        emit,
        diagnose,
      }),
    ).rejects.toBe(error);
    expect(lines.at(-1)).toEqual({
      level: 'error',
      message: 'Terminal launch failed: opaque failure',
    });
  });
});
