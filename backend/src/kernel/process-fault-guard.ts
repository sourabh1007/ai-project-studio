import type { Logger } from './logger.js';

/** The two process-level events that end a Node process by default. */
export type ProcessFaultKind = 'uncaughtException' | 'unhandledRejection';

export interface ProcessFault {
  kind: ProcessFaultKind;
  name: string;
  message: string;
  stack?: string;
}

/** The slice of `process` the guard needs, so tests need no real process. */
export interface FaultProcess {
  on(event: 'uncaughtException', listener: (error: unknown) => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  // Matches Node's own broad listener type so the real `process` is assignable.
  removeListener(
    event: string,
    listener: (...args: any[]) => void,
  ): unknown;
}

export interface ProcessFaultGuardDeps {
  process: FaultProcess;
  logger: Pick<Logger, 'error'>;
  /** Notified after logging, e.g. to surface a degraded state to the desktop. */
  onFault?: (fault: ProcessFault) => void;
}

/** Normalizes any thrown or rejected value into a reportable shape. */
export function describeFault(
  kind: ProcessFaultKind,
  value: unknown,
): ProcessFault {
  if (value instanceof Error) {
    return {
      kind,
      name: value.name,
      message: value.message,
      ...(value.stack === undefined ? {} : { stack: value.stack }),
    };
  }
  // Rejections frequently carry a non-Error (a string, a response object, or
  // `undefined` from a bare `Promise.reject()`), which must still be reported.
  return { kind, name: typeof value, message: String(value) };
}

/**
 * Keeps the backend alive through faults that would otherwise terminate it.
 *
 * On Node 15+ an unhandled promise rejection terminates the process by
 * default. With no handler installed, a single stray rejection anywhere took
 * the whole backend down, and because the desktop does not respawn it, every
 * UI surface failed at once: requests timed out, lists hung on skeletons, and
 * unrelated features all appeared broken simultaneously.
 *
 * Staying up is the lesser risk here. A rejection usually dooms one request,
 * whereas exiting dooms the session: the user loses warm metasessions and
 * running work with no way back. Both faults are therefore logged in full —
 * the diagnosis that was previously lost — and serving continues.
 *
 * @returns a function that removes the handlers.
 */
export function installProcessFaultGuard(
  deps: ProcessFaultGuardDeps,
): () => void {
  const report = (kind: ProcessFaultKind) => (value: unknown): void => {
    const fault = describeFault(kind, value);
    deps.logger.error(
      kind === 'uncaughtException'
        ? 'Uncaught exception; the backend stayed up and continues serving'
        : 'Unhandled promise rejection; the backend stayed up and continues serving',
      fault,
    );
    deps.onFault?.(fault);
  };

  const onException = report('uncaughtException');
  const onRejection = report('unhandledRejection');
  deps.process.on('uncaughtException', onException);
  deps.process.on('unhandledRejection', onRejection);

  return () => {
    deps.process.removeListener('uncaughtException', onException);
    deps.process.removeListener('unhandledRejection', onRejection);
  };
}
