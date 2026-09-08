export interface Stoppable {
  stop(): void;
}

export interface ShutdownTailer {
  finalize?(): unknown;
  stop(): void;
}

export interface ShutdownTerminalManager {
  shutdown(): void;
  waitForIdle(timeoutMs: number): Promise<boolean>;
}

export interface ShutdownServer {
  close(): void | Promise<void>;
}

export interface ShutdownDb {
  close(): void;
}

export interface ShutdownScheduler {
  shutdown(): void;
  waitForIdle(timeoutMs: number): Promise<boolean>;
}

export interface ShutdownOwner {
  abort(): void;
  waitForIdle(timeoutMs: number): Promise<boolean>;
}

export interface ShutdownPool {
  closeAndWait(timeoutMs: number): Promise<boolean>;
}

export interface ShutdownCoordinatorDeps {
  admission: { close(): void };
  requests: ShutdownScheduler;
  scheduler: ShutdownScheduler;
  headless: ShutdownScheduler;
  owner: ShutdownOwner;
  pools: Iterable<ShutdownPool>;
  tailers: Iterable<ShutdownTailer>;
  credentialWarmer: Stoppable;
  terminalManager: ShutdownTerminalManager;
  server: ShutdownServer;
  db: ShutdownDb;
  settleOwnership: () => Promise<void>;
  acknowledge: () => Promise<void>;
  exit: (code: number) => void;
  timeoutMs: number;
  reportError: (message: string, error: unknown) => void;
}

/**
 * Coordinates one-way backend shutdown so new headless work stops immediately,
 * in-flight work is asked to abort, warm pools are drained boundedly, and the
 * database closes only after every owner confirms settlement. An unconfirmed
 * attempt leaves the backend alive and can be retried without reopening admission.
 */
export function createShutdownCoordinator(
  deps: ShutdownCoordinatorDeps,
): (signal: string) => Promise<boolean> {
  let active: Promise<boolean> | null = null;
  let confirmed = false;
  let drained = false;
  let transportClosed = false;
  let storageClosed = false;
  let acknowledged = false;
  let ownershipSettled = false;
  const tailers = new Set<ShutdownTailer>();
  const finalized = new Set<ShutdownTailer>();

  const run = async (): Promise<boolean> => {
    let failed = false;
    const report = (message: string, error: unknown) => {
      failed = true;
      deps.reportError(message, error);
    };
    const stop = (name: string, action: () => void) => {
      try {
        action();
      } catch (error) {
        report(`Shutdown could not stop ${name}`, error);
      }
    };
    const drain = async (name: string, action: () => Promise<boolean>) => {
      try {
        if (!await action()) {
          report(`Shutdown is unconfirmed: ${name} still owns work`, new Error('Drain timed out'));
        }
      } catch (error) {
        report(`Shutdown could not drain ${name}`, error);
      }
    };

    if (!drained) {
      for (const tailer of deps.tailers) tailers.add(tailer);
      stop('process admission', () => deps.admission.close());
      stop('application admission', () => deps.requests.shutdown());
      stop('scheduler admission', () => deps.scheduler.shutdown());
      stop('headless admission', () => deps.headless.shutdown());
      stop('AI work', () => deps.owner.abort());
      stop('terminal admission', () => deps.terminalManager.shutdown());
      stop('credential warmer', () => deps.credentialWarmer.stop());
      for (const tailer of tailers) {
        stop('usage poller', () => tailer.stop());
      }
      await Promise.all([
        drain('application work', () => deps.requests.waitForIdle(deps.timeoutMs)),
        drain('scheduler', () => deps.scheduler.waitForIdle(deps.timeoutMs)),
        drain('headless sessions', () => deps.headless.waitForIdle(deps.timeoutMs)),
        drain('AI work', () => deps.owner.waitForIdle(deps.timeoutMs)),
        drain('terminals', () => deps.terminalManager.waitForIdle(deps.timeoutMs)),
        ...[...deps.pools].map((pool) =>
          drain('warm pool', () => pool.closeAndWait(deps.timeoutMs))),
      ]);
      if (failed) return false;
      drained = true;
    }
    if (!ownershipSettled) {
      try {
        await deps.settleOwnership();
        ownershipSettled = true;
      } catch (error) {
        report('Shutdown could not reconcile drained ownership', error);
        return false;
      }
    }
    for (const tailer of tailers) {
      if (finalized.has(tailer)) continue;
      try {
        tailer.finalize?.();
        finalized.add(tailer);
      } catch (error) {
        report('Shutdown could not finalize usage capture', error);
      }
    }
    if (failed) return false;
    try {
      if (!transportClosed) {
        await deps.server.close();
        transportClosed = true;
      }
      if (!storageClosed) {
        deps.db.close();
        storageClosed = true;
      }
    } catch (error) {
      report('Shutdown could not close storage or transport', error);
      return false;
    }
    if (!acknowledged) {
      try {
        await deps.acknowledge();
        acknowledged = true;
      } catch (error) {
        report('Shutdown could not acknowledge completed cleanup', error);
        return false;
      }
    }
    deps.exit(0);
    return true;
  };

  return (_signal: string): Promise<boolean> => {
    if (confirmed) return Promise.resolve(true);
    if (active) return active;
    let resolve!: (value: boolean) => void;
    active = new Promise<boolean>((yes) => { resolve = yes; });
    const attempt = active;
    void run().then(
      (result) => {
        confirmed = result;
        active = null;
        resolve(result);
      },
      (error: unknown) => {
        active = null;
        deps.reportError('Shutdown attempt failed', error);
        resolve(false);
      },
    );
    return attempt;
  };
}
