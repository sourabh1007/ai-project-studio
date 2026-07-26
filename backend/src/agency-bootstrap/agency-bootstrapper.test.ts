import { describe, it, expect } from 'vitest';
import {
  createAgencyBootstrapper,
  type AgencyInstallEvent,
} from './agency-bootstrapper.js';
import type {
  ProcessHandle,
  ProcessSpawner,
  SpawnRequest,
} from '../process-kernel/process-spawner.js';

/** A spawner whose single handle streams the given lines then exits with code. */
function scriptedSpawner(script: {
  stdout?: string[];
  stderr?: string[];
  code: number | null;
}) {
  const requests: SpawnRequest[] = [];
  let stdoutCb: (line: string) => void = () => {};
  let stderrCb: (line: string) => void = () => {};
  const handle: ProcessHandle = {
    onStdoutLine: (cb) => {
      stdoutCb = cb;
    },
    onStderrLine: (cb) => {
      stderrCb = cb;
    },
    onExit: () => {},
    kill: () => {},
    done: Promise.resolve().then(() => {
      for (const line of script.stdout ?? []) {
        stdoutCb(line);
      }
      for (const line of script.stderr ?? []) {
        stderrCb(line);
      }
      return script.code;
    }),
    snapshot: () => ({ phase: 'exited' }),
  };
  const spawner: ProcessSpawner = {
    spawn: (req) => {
      requests.push(req);
      return handle;
    },
  };
  return { spawner, requests };
}

describe('createAgencyBootstrapper', () => {
  it('status reflects the detector', () => {
    const yes = createAgencyBootstrapper({
      platform: 'linux',
      detect: () => true,
      spawner: scriptedSpawner({ code: 0 }).spawner,
      env: {},
    });
    const no = createAgencyBootstrapper({
      platform: 'linux',
      detect: () => false,
      spawner: scriptedSpawner({ code: 0 }).spawner,
      env: {},
    });
    expect(yes.status()).toEqual({ installed: true });
    expect(no.status()).toEqual({ installed: false });
  });

  it('short-circuits install when agency is already present', async () => {
    const { spawner, requests } = scriptedSpawner({ code: 0 });
    const boot = createAgencyBootstrapper({
      platform: 'linux',
      detect: () => true,
      spawner,
      env: {},
    });
    const events: AgencyInstallEvent[] = [];
    const status = await boot.install((e) => events.push(e));
    expect(status).toEqual({ installed: true });
    expect(events).toEqual([{ kind: 'done' }]);
    expect(requests).toHaveLength(0);
  });

  it('streams output and reports done on a successful install', async () => {
    const { spawner, requests } = scriptedSpawner({
      stdout: ['downloading'],
      stderr: ['warn: slow'],
      code: 0,
    });
    let installed = false;
    const boot = createAgencyBootstrapper({
      platform: 'win32',
      detect: () => installed,
      spawner,
      env: { PATH: '/bin' },
    });
    // Detector flips to installed once the install process has run.
    const events: AgencyInstallEvent[] = [];
    const status = await boot.install((e) => {
      if (e.kind === 'line' && e.line === 'downloading') {
        installed = true;
      }
      events.push(e);
    });
    expect(status).toEqual({ installed: true });
    expect(events).toEqual([
      { kind: 'line', line: 'downloading' },
      { kind: 'line', line: 'warn: slow' },
      { kind: 'done' },
    ]);
    expect(requests[0]?.command).toBe('powershell');
    expect(requests[0]?.env).toEqual({ PATH: '/bin' });
  });

  it('reports an error when the install process exits non-zero', async () => {
    const { spawner } = scriptedSpawner({ code: 1 });
    const boot = createAgencyBootstrapper({
      platform: 'linux',
      detect: () => false,
      spawner,
      env: {},
    });
    const events: AgencyInstallEvent[] = [];
    const status = await boot.install((e) => events.push(e));
    expect(status).toEqual({ installed: false });
    expect(events).toEqual([
      { kind: 'error', message: 'agency install failed (exit code 1)' },
    ]);
  });

  it('reports an error when the process succeeds but agency is still missing', async () => {
    const { spawner } = scriptedSpawner({ code: 0 });
    const boot = createAgencyBootstrapper({
      platform: 'linux',
      detect: () => false,
      spawner,
      env: {},
    });
    const events: AgencyInstallEvent[] = [];
    const status = await boot.install((e) => events.push(e));
    expect(status).toEqual({ installed: false });
    expect(events).toEqual([
      { kind: 'error', message: 'agency install failed (exit code 0)' },
    ]);
  });

  it('renders a null exit code in the error message', async () => {
    const { spawner } = scriptedSpawner({ code: null });
    const boot = createAgencyBootstrapper({
      platform: 'linux',
      detect: () => false,
      spawner,
      env: {},
    });
    const events: AgencyInstallEvent[] = [];
    await boot.install((e) => events.push(e));
    expect(events).toEqual([
      { kind: 'error', message: 'agency install failed (exit code null)' },
    ]);
  });
});
