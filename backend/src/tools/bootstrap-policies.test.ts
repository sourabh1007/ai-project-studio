import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgencyBootstrapper } from '../agency-bootstrap/agency-bootstrapper.js';
import { createCopilotBootstrapper } from '../copilot-bootstrap/copilot-bootstrapper.js';
import type { ProcessHandle, SpawnRequest } from '../provider/process-kernel/process-spawner.js';

afterEach(() => vi.useRealTimers());
describe.each([
  ['Agency', createAgencyBootstrapper],
  ['Copilot', createCopilotBootstrapper],
] as const)('%s bounded installer policy', (_name, create) => {
  it('kills a timed-out installer and refuses overlapping work until native exit acknowledgement', async () => {
    vi.useFakeTimers();
    let acknowledge!: (code: number) => void;
    const kill = vi.fn();
    const handle = {
      done: new Promise<number>((resolve) => { acknowledge = resolve; }),
      kill, onStdoutLine: () => {}, onStderrLine: () => {},
    } as unknown as ProcessHandle;
    const spawn = vi.fn(() => handle);
    const boot = create({
      platform: 'linux', detect: () => false, spawner: { spawn }, env: {},
      installConfig: () => ({ windowsExecutable: 'powershell', posixExecutable: 'sh', installTimeoutMs: 20 }),
    });
    const installing = boot.install(() => {});
    await vi.advanceTimersByTimeAsync(20);
    expect(await installing).toMatchObject({ installed: false });
    expect(kill).toHaveBeenCalledOnce();
    await boot.install(() => {});
    expect(spawn).toHaveBeenCalledOnce();
    acknowledge(0);
    await vi.advanceTimersByTimeAsync(0);
    await boot.install(() => {});
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it('bounds unavailable version probes and never declares a missing executable upgraded', async () => {
    vi.useFakeTimers();
    const boot = create({
      platform: 'linux', detect: () => false, env: {},
      spawner: { spawn: () => ({
        done: Promise.resolve(0), onStdoutLine: () => {}, onStderrLine: () => {},
      } as unknown as ProcessHandle) },
      readVersion: () => new Promise(() => {}),
      installConfig: () => ({ windowsExecutable: 'powershell', posixExecutable: 'sh', versionTimeoutMs: 10 }),
    });
    const upgrading = boot.upgradeToLatest(() => {});
    await vi.advanceTimersByTimeAsync(10);
    expect(await upgrading).toMatchObject({ installed: false, upgrade: { phase: 'error' } });
  });
});

it('Copilot installer explicitly honors the configured install-script policy over inherited npm settings', async () => {
  let request!: SpawnRequest;
  const boot = createCopilotBootstrapper({
    platform: 'linux', detect: () => false,
    env: { npm_config_ignore_scripts: 'false', NPM_CONFIG_IGNORE_SCRIPTS: 'false' },
    installConfig: () => ({ windowsExecutable: 'cmd', posixExecutable: 'sh', allowInstallScripts: false }),
    spawner: { spawn: (value) => {
      request = value;
      return { done: Promise.resolve(1), onStdoutLine: () => {}, onStderrLine: () => {} } as unknown as ProcessHandle;
    } },
  });
  await boot.install(() => {});
  expect(request.env).toEqual({ npm_config_ignore_scripts: 'true', NPM_CONFIG_IGNORE_SCRIPTS: 'true' });
});
