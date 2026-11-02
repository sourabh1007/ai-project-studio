import { describe, it, expect, vi } from 'vitest';
import {
  describeFault,
  installProcessFaultGuard,
  type FaultProcess,
  type ProcessFault,
} from './process-fault-guard.js';

function fakeProcess() {
  const listeners = new Map<string, (value: unknown) => void>();
  const removed: string[] = [];
  const proc = {
    on(event: string, listener: (value: unknown) => void) {
      listeners.set(event, listener);
      return proc;
    },
    removeListener(event: string) {
      removed.push(event);
      listeners.delete(event);
      return proc;
    },
  } as unknown as FaultProcess;
  return {
    proc,
    removed,
    emit: (event: string, value: unknown) => listeners.get(event)?.(value),
    has: (event: string) => listeners.has(event),
  };
}

function setup() {
  const error = vi.fn();
  const faults: ProcessFault[] = [];
  const host = fakeProcess();
  const dispose = installProcessFaultGuard({
    process: host.proc,
    logger: { error },
    onFault: (fault) => faults.push(fault),
  });
  return { ...host, error, faults, dispose };
}

describe('describeFault', () => {
  it('keeps the name, message and stack of a real error', () => {
    const error = new TypeError('bad input');
    expect(describeFault('uncaughtException', error)).toEqual({
      kind: 'uncaughtException',
      name: 'TypeError',
      message: 'bad input',
      stack: error.stack,
    });
  });

  it('omits a missing stack rather than reporting undefined', () => {
    const error = new Error('no stack');
    delete error.stack;
    expect(describeFault('unhandledRejection', error)).toEqual({
      kind: 'unhandledRejection',
      name: 'Error',
      message: 'no stack',
    });
  });

  it.each([
    ['a string reason', 'boom', 'string', 'boom'],
    ['a bare undefined rejection', undefined, 'undefined', 'undefined'],
    ['a non-error object', { status: 500 }, 'object', '[object Object]'],
  ])('describes %s', (_label, value, name, message) => {
    expect(describeFault('unhandledRejection', value)).toEqual({
      kind: 'unhandledRejection',
      name,
      message,
    });
  });
});

describe('installProcessFaultGuard', () => {
  it('survives an unhandled rejection instead of letting the process exit', () => {
    // Without this guard Node terminates the backend, which is what made every
    // unrelated UI surface fail at once.
    const { emit, error, faults } = setup();
    emit('unhandledRejection', new Error('provider call failed'));

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(/stayed up and continues serving/);
    expect(faults).toEqual([
      expect.objectContaining({
        kind: 'unhandledRejection',
        message: 'provider call failed',
      }),
    ]);
  });

  it('survives an uncaught exception and reports it', () => {
    const { emit, error, faults } = setup();
    emit('uncaughtException', new Error('boom'));

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(/^Uncaught exception/);
    expect(faults[0].kind).toBe('uncaughtException');
  });

  it('keeps serving across repeated faults', () => {
    const { emit, error } = setup();
    emit('unhandledRejection', new Error('first'));
    emit('unhandledRejection', new Error('second'));
    emit('uncaughtException', new Error('third'));
    expect(error).toHaveBeenCalledTimes(3);
  });

  it('works without an onFault observer', () => {
    const error = vi.fn();
    const host = fakeProcess();
    installProcessFaultGuard({ process: host.proc, logger: { error } });
    expect(() => host.emit('unhandledRejection', 'boom')).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('removes both handlers when disposed', () => {
    const { dispose, removed, has } = setup();
    dispose();
    expect(removed.sort()).toEqual(['uncaughtException', 'unhandledRejection']);
    expect(has('unhandledRejection')).toBe(false);
  });
});

describe('fault guard reporter failures', () => {
  it('contains a throwing logger and still notifies onFault', () => {
    const host = fakeProcess();
    const faults: ProcessFault[] = [];
    const failures: Array<[string, string]> = [];
    installProcessFaultGuard({
      process: host.proc,
      logger: { error: () => { throw new TypeError('EPIPE'); } },
      onFault: (fault) => faults.push(fault),
      onReportFailure: (f) => failures.push([f.sink, f.errorName]),
    });
    expect(() => host.emit('uncaughtException', new Error('boom'))).not.toThrow();
    expect(faults).toHaveLength(1);
    expect(failures).toEqual([['fault-guard.logger', 'TypeError']]);
  });

  it('contains a throwing onFault and a throwing failure reporter', () => {
    const host = fakeProcess();
    installProcessFaultGuard({
      process: host.proc,
      logger: { error: () => { throw new Error('a'); } },
      onFault: () => { throw new Error('b'); },
      onReportFailure: () => { throw new Error('c'); },
    });
    expect(() => host.emit('unhandledRejection', 'x')).not.toThrow();
  });

  it('defaults to a stderr failure line', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const host = fakeProcess();
    installProcessFaultGuard({ process: host.proc, logger: { error: () => { throw new Error('a'); } } });
    host.emit('unhandledRejection', 'x');
    expect(JSON.parse(String(spy.mock.calls[0][0])).sink).toBe('fault-guard.logger');
    spy.mockRestore();
  });
});
