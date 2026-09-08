import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { createShutdownCoordinator, type ShutdownCoordinatorDeps } from './shutdown-coordinator.js';

function fixture() {
  const deps = {
    admission: { close: vi.fn() },
    requests: { shutdown: vi.fn(), waitForIdle: vi.fn(async () => true) },
    scheduler: { shutdown: vi.fn(), waitForIdle: vi.fn(async () => true) },
    headless: { shutdown: vi.fn(), waitForIdle: vi.fn(async () => true) },
    owner: { abort: vi.fn(), waitForIdle: vi.fn(async () => true) },
    terminalManager: { shutdown: vi.fn(), waitForIdle: vi.fn(async () => true) },
    credentialWarmer: { stop: vi.fn() },
    pools: [{ closeAndWait: vi.fn(async () => true) }],
    tailers: [{ stop: vi.fn(), finalize: vi.fn() }],
    server: { close: vi.fn<() => void | Promise<void>>() },
    db: { close: vi.fn() },
    settleOwnership: vi.fn(async () => {}),
    acknowledge: vi.fn(async () => {}),
    exit: vi.fn(),
    reportError: vi.fn(),
    timeoutMs: 5,
  } satisfies ShutdownCoordinatorDeps;
  return { deps, shutdown: createShutdownCoordinator(deps) };
}

describe('createShutdownCoordinator', () => {
  it('closes all admission synchronously and waits for final persistence before closing storage', async () => {
    const { deps, shutdown } = fixture();
    let finish!: (confirmed: boolean) => void;
    deps.headless.waitForIdle.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = shutdown('SIGTERM');
    expect(deps.admission.close).toHaveBeenCalledOnce();
    expect(deps.admission.close.mock.invocationCallOrder[0]).toBeLessThan(deps.requests.shutdown.mock.invocationCallOrder[0]);
    expect(deps.scheduler.shutdown).toHaveBeenCalledOnce();
    expect(deps.headless.shutdown).toHaveBeenCalledOnce();
    expect(deps.owner.abort).toHaveBeenCalledOnce();
    expect(deps.terminalManager.shutdown).toHaveBeenCalledOnce();
    expect(deps.credentialWarmer.stop).toHaveBeenCalledOnce();
    expect(deps.tailers[0].stop).toHaveBeenCalledOnce();
    expect(deps.db.close).not.toHaveBeenCalled();
    expect(deps.tailers[0].finalize).not.toHaveBeenCalled();
    finish(true);
    expect(await pending).toBe(true);
    expect(deps.tailers[0].finalize).toHaveBeenCalledOnce();
    expect(deps.server.close).toHaveBeenCalledOnce();
    expect(deps.db.close).toHaveBeenCalledOnce();
    expect(deps.acknowledge).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledWith(0);
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it('shares a pending attempt and never repeats a confirmed shutdown', async () => {
    const { deps, shutdown } = fixture();
    const first = shutdown('SIGINT');
    expect(shutdown('SIGTERM')).toBe(first);
    expect(await first).toBe(true);
    expect(await shutdown('again')).toBe(true);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it.each(['requests', 'scheduler', 'headless', 'owner', 'terminalManager'] as const)(
    'keeps the backend alive when %s cannot confirm settlement, then allows retry',
    async (key) => {
      const { deps, shutdown } = fixture();
      deps[key].waitForIdle.mockResolvedValueOnce(false);
      expect(await shutdown('first')).toBe(false);
      expect(deps.server.close).not.toHaveBeenCalled();
      expect(deps.db.close).not.toHaveBeenCalled();
      expect(deps.exit).not.toHaveBeenCalled();
      expect(deps.reportError).toHaveBeenCalled();
      expect(await shutdown('retry')).toBe(true);
      expect(deps.exit).toHaveBeenCalledOnce();
    },
  );

  it('does not confuse warm-pool timeout or rejection with confirmed termination', async () => {
    const { deps, shutdown } = fixture();
    deps.pools[0].closeAndWait.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('pool failed'));
    expect(await shutdown('timeout')).toBe(false);
    expect(await shutdown('rejected')).toBe(false);
    expect(deps.db.close).not.toHaveBeenCalled();
    expect(await shutdown('confirmed')).toBe(true);
  });

  it('still cancels other owners when a stop request throws, without closing the database', async () => {
    const { deps, shutdown } = fixture();
    deps.tailers[0].stop.mockImplementationOnce(() => { throw new Error('poller still running'); });
    expect(await shutdown('SIGTERM')).toBe(false);
    expect(deps.owner.abort).toHaveBeenCalledOnce();
    expect(deps.headless.waitForIdle).toHaveBeenCalledOnce();
    expect(deps.terminalManager.waitForIdle).toHaveBeenCalledOnce();
    expect(deps.exit).not.toHaveBeenCalled();
    expect(await shutdown('retry')).toBe(true);
  });

  it('still cancels every producer after an admission-close failure, and retains storage for retry', async () => {
    const { deps, shutdown } = fixture();
    deps.admission.close.mockImplementationOnce(() => { throw new Error('admission close failed'); });
    expect(await shutdown('first')).toBe(false);
    expect(deps.requests.shutdown).toHaveBeenCalledOnce();
    expect(deps.headless.shutdown).toHaveBeenCalledOnce();
    expect(deps.owner.abort).toHaveBeenCalledOnce();
    expect(deps.db.close).not.toHaveBeenCalled();
    expect(await shutdown('retry')).toBe(true);
  });

  it('retains storage and reports a final usage persistence failure', async () => {
    const { deps, shutdown } = fixture();
    deps.tailers[0].finalize.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(await shutdown('SIGTERM')).toBe(false);
    expect(deps.server.close).not.toHaveBeenCalled();
    expect(deps.db.close).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
    expect(await shutdown('retry')).toBe(true);
  });

  it('does not report success when database closing fails', async () => {
    const { deps, shutdown } = fixture();
    deps.db.close.mockImplementation(() => { throw new Error('database close failed'); });
    expect(await shutdown('SIGTERM')).toBe(false);
    expect(deps.exit).not.toHaveBeenCalled();
    expect(deps.acknowledge).not.toHaveBeenCalled();
    expect(deps.reportError).toHaveBeenCalledWith(
      'Shutdown could not close storage or transport', expect.any(Error),
    );
  });

  it('retries storage after actual transport closure without attempting to close the server again', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { deps, shutdown } = fixture();
    deps.server.close.mockImplementation(() => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }));
    deps.db.close.mockImplementationOnce(() => { throw new Error('storage temporarily busy'); });
    try {
      expect(await shutdown('first')).toBe(false);
      expect(server.listening).toBe(false);
      expect(deps.acknowledge).not.toHaveBeenCalled();
      expect(await shutdown('ipc-retry')).toBe(true);
      expect(deps.server.close).toHaveBeenCalledTimes(1);
      expect(deps.db.close).toHaveBeenCalledTimes(2);
      expect(deps.headless.waitForIdle).toHaveBeenCalledTimes(1);
      expect(deps.tailers[0].finalize).toHaveBeenCalledTimes(1);
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('retains completed cleanup phases while retrying a failed acknowledgement', async () => {
    const { deps, shutdown } = fixture();
    deps.acknowledge.mockRejectedValueOnce(new Error('IPC delivery failed'));
    expect(await shutdown('first')).toBe(false);
    expect(deps.exit).not.toHaveBeenCalled();
    expect(await shutdown('ipc-retry')).toBe(true);
    expect(deps.server.close).toHaveBeenCalledTimes(1);
    expect(deps.db.close).toHaveBeenCalledTimes(1);
    expect(deps.tailers[0].finalize).toHaveBeenCalledTimes(1);
    expect(deps.acknowledge).toHaveBeenCalledTimes(2);
  });

  it('requires ownership reconciliation after physical drain and before storage closure', async () => {
    const { deps, shutdown } = fixture();
    deps.headless.waitForIdle.mockResolvedValueOnce(false);
    expect(await shutdown('unconfirmed process')).toBe(false);
    expect(deps.settleOwnership).not.toHaveBeenCalled();
    deps.settleOwnership.mockRejectedValueOnce(new Error('ownership not settled'));
    expect(await shutdown('unconfirmed ownership')).toBe(false);
    expect(deps.db.close).not.toHaveBeenCalled();
    expect(await shutdown('retry ownership')).toBe(true);
    expect(deps.headless.waitForIdle).toHaveBeenCalledTimes(2);
  });

  it('does not exit until the acknowledgement send callback completes', async () => {
    const { deps, shutdown } = fixture();
    let finish!: () => void;
    deps.acknowledge.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = shutdown('first');
    await vi.waitFor(() => expect(deps.acknowledge).toHaveBeenCalledOnce());
    expect(deps.db.close).toHaveBeenCalledOnce();
    expect(deps.exit).not.toHaveBeenCalled();
    expect(shutdown('again')).toBe(pending);
    finish();
    expect(await pending).toBe(true);
  });

  it('waits for asynchronous transport closure before closing storage', async () => {
    const { deps, shutdown } = fixture();
    let finish!: () => void;
    deps.server.close.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = shutdown('SIGTERM');
    await vi.waitFor(() => expect(deps.server.close).toHaveBeenCalledOnce());
    expect(deps.db.close).not.toHaveBeenCalled();
    finish();
    expect(await pending).toBe(true);
  });

  it('supports a stopped capture without an optional finalizer', async () => {
    const { deps } = fixture();
    const shutdown = createShutdownCoordinator({ ...deps, tailers: [{ stop: vi.fn() }] });
    expect(await shutdown('SIGTERM')).toBe(true);
  });

  it('reports an unexpected exit failure and releases the pending attempt', async () => {
    const { deps, shutdown } = fixture();
    deps.exit.mockImplementationOnce(() => { throw new Error('exit rejected'); });
    expect(await shutdown('SIGTERM')).toBe(false);
    expect(deps.reportError).toHaveBeenCalledWith('Shutdown attempt failed', expect.any(Error));
    expect(await shutdown('retry')).toBe(true);
  });
});
