import { describe, expect, it, vi } from 'vitest';
import {
  classifyLaunchFailure,
  healErrorText,
  healTerminalLaunch,
  launchWithSelfHealing,
  suggestLaunchFix,
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

describe('classifyLaunchFailure', () => {
  it('detects a missing working directory', () => {
    expect(classifyLaunchFailure('Cannot create process, error code: 267')).toBe('missing-cwd');
    expect(classifyLaunchFailure('The directory name is invalid')).toBe('missing-cwd');
    expect(classifyLaunchFailure('chdir failed')).toBe('missing-cwd');
  });

  it('detects a missing CLI binary', () => {
    expect(classifyLaunchFailure('spawn copilot ENOENT')).toBe('missing-cli');
    expect(classifyLaunchFailure('command not found: copilot')).toBe('missing-cli');
    expect(
      classifyLaunchFailure("'agency' is not recognized as an internal or external command"),
    ).toBe('missing-cli');
  });

  it('detects permission failures', () => {
    expect(classifyLaunchFailure('EPERM: operation not permitted')).toBe('permission');
    expect(classifyLaunchFailure('Access is denied')).toBe('permission');
  });

  it('detects transient system failures', () => {
    expect(classifyLaunchFailure('EBUSY: resource busy')).toBe('transient');
    expect(classifyLaunchFailure('forkpty(3) failed')).toBe('transient');
    expect(classifyLaunchFailure('The pipe has been ended')).toBe('transient');
  });

  it('falls back to unknown for unrecognized text', () => {
    expect(classifyLaunchFailure('something totally different')).toBe('unknown');
  });
});

describe('suggestLaunchFix', () => {
  it('returns a concrete message for known causes and null for unknown', () => {
    expect(suggestLaunchFix('missing-cli')).toContain('CLI could not be found');
    expect(suggestLaunchFix('permission')).toContain('permission denied');
    expect(suggestLaunchFix('missing-cwd')).toContain('working directory');
    expect(suggestLaunchFix('transient')).toContain('transient');
    expect(suggestLaunchFix('unknown')).toBeNull();
  });
});

describe('healTerminalLaunch', () => {
  it('recreates a folder-bound cwd in place and relaunches there, never relocating', async () => {
    const dirs = new Set<string>(['C:\\shared']);
    const launchedIn: string[] = [];
    const launch = vi.fn(async (cwd: string) => {
      launchedIn.push(cwd);
      if (!dirs.has(cwd)) throw new Error('Cannot create process, error code: 267');
      return 'ok';
    });
    const { emit } = collector();
    const result = await launchWithSelfHealing({
      launch,
      fs: fakeFs(dirs),
      emit,
      resolvedCwd: 'C:\\isolated',
      fallbackCwd: 'C:\\shared',
      allowCwdRepair: false,
    });
    expect(result).toBe('ok');
    // Recreated its own path and relaunched there — never the shared fallback.
    expect(launchedIn).toEqual(['C:\\isolated', 'C:\\isolated']);
    expect(dirs.has('C:\\isolated')).toBe(true);
    expect(launchedIn).not.toContain('C:\\shared');
  });

  it('still fails a folder-bound session when its directory cannot be recreated', async () => {
    const fs = { dirExists: vi.fn(() => false), ensureDir: vi.fn(() => false) };
    const launch = vi.fn(async () => { throw new Error('Cannot create process, error code: 267'); });
    const { emit, lines } = collector();
    await expect(launchWithSelfHealing({
      launch, fs, emit, resolvedCwd: 'C:\\isolated', fallbackCwd: 'C:\\shared', allowCwdRepair: false,
    })).rejects.toThrow('error code: 267');
    expect(fs.ensureDir).toHaveBeenCalledWith('C:\\isolated');
    expect(lines.at(-1)?.message).toContain('error code: 267');
  });

  it('does not relocate a folder-bound session to the workspace root', () => {
    const { lines, emit } = collector();
    const decision = healTerminalLaunch({
      cwd: 'C:/repo',
      fallbackCwd: 'C:/work',
      fs: fakeFs(new Set(['C:/work']), { canCreate: false }),
      emit,
      inPlaceOnly: true,
    });
    expect(decision).toBeNull();
    expect(lines.some((l) => l.message.includes('C:/work'))).toBe(false);
    expect(lines.at(-1)?.level).toBe('error');
  });
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

  it('retries a transient failure in place and succeeds', async () => {
    const { emit, lines } = collector();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error('EBUSY: resource busy'))
      .mockResolvedValueOnce('terminal');
    const result = await launchWithSelfHealing({
      launch,
      resolvedCwd: 'C:/repo',
      fallbackCwd: 'C:/work',
      fs: fakeFs(new Set(['C:/repo'])),
      emit,
      sleep,
    });
    expect(result).toBe('terminal');
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenNthCalledWith(2, 'C:/repo');
    expect(sleep).toHaveBeenCalledOnce();
    expect(lines.some((l) => l.message.includes('Retrying'))).toBe(true);
  });

  it('gives up after exhausting transient retries and suggests a fix', async () => {
    const { emit, lines } = collector();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const error = new Error('forkpty(3) failed');
    const launch = vi.fn().mockRejectedValue(error);
    const suggestFix = vi.fn(() => 'Launch again in a moment.');
    const diagnose = vi.fn();
    await expect(
      launchWithSelfHealing({
        launch,
        resolvedCwd: 'C:/repo',
        fallbackCwd: 'C:/work',
        fs: fakeFs(new Set(['C:/repo', 'C:/work'])),
        emit,
        sleep,
        maxRetries: 1,
        suggestFix,
        diagnose,
      }),
    ).rejects.toBe(error);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(suggestFix).toHaveBeenCalledWith('transient', 'forkpty(3) failed');
    expect(diagnose).not.toHaveBeenCalled();
    expect(lines.some((l) => l.message === 'Launch again in a moment.')).toBe(true);
    expect(lines.at(-1)?.message).toContain('forkpty(3) failed');
  });

  it('emits a deterministic suggestion and skips AI diagnosis for known causes', async () => {
    const { emit, lines } = collector();
    const error = new Error('spawn copilot ENOENT');
    const launch = vi.fn().mockRejectedValue(error);
    const suggestFix = vi.fn(() => 'Install the CLI.');
    const diagnose = vi.fn();
    await expect(
      launchWithSelfHealing({
        launch,
        resolvedCwd: 'C:/repo',
        fallbackCwd: 'C:/work',
        fs: fakeFs(new Set(['C:/repo', 'C:/work'])),
        emit,
        suggestFix,
        diagnose,
      }),
    ).rejects.toBe(error);
    expect(suggestFix).toHaveBeenCalledWith('missing-cli', 'spawn copilot ENOENT');
    expect(diagnose).not.toHaveBeenCalled();
    expect(lines.some((l) => l.message === 'Install the CLI.')).toBe(true);
    expect(lines.some((l) => l.message.includes('analyzing the failure'))).toBe(false);
  });

  it('falls back to AI diagnosis when the suggestion is null (unknown cause)', async () => {
    const { emit, lines } = collector();
    const error = new Error('totally novel failure');
    const launch = vi.fn().mockRejectedValue(error);
    const suggestFix = vi.fn(() => null);
    const diagnose = vi.fn().mockResolvedValue('Here is what happened.');
    await expect(
      launchWithSelfHealing({
        launch,
        resolvedCwd: 'C:/repo',
        fallbackCwd: 'C:/work',
        fs: fakeFs(new Set(['C:/repo', 'C:/work'])),
        emit,
        suggestFix,
        diagnose,
      }),
    ).rejects.toBe(error);
    expect(suggestFix).toHaveBeenCalledWith('unknown', 'totally novel failure');
    expect(diagnose).toHaveBeenCalledWith('totally novel failure');
    expect(lines.some((l) => l.message.includes('analyzing the failure'))).toBe(true);
    expect(lines.some((l) => l.message === 'Here is what happened.')).toBe(true);
  });

  it('uses a real timer when no sleep is injected for a transient retry', async () => {
    vi.useFakeTimers();
    try {
      const { emit } = collector();
      const launch = vi
        .fn()
        .mockRejectedValueOnce(new Error('EAGAIN'))
        .mockResolvedValueOnce('terminal');
      const promise = launchWithSelfHealing({
        launch,
        resolvedCwd: 'C:/repo',
        fallbackCwd: 'C:/work',
        fs: fakeFs(new Set(['C:/repo'])),
        emit,
      });
      await vi.runAllTimersAsync();
      expect(await promise).toBe('terminal');
      expect(launch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
