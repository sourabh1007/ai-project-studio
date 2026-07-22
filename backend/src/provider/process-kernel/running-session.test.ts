import { describe, it, expect } from 'vitest';
import { toRunningSession } from './running-session.js';
import type { ProcessHandle } from './process-spawner.js';
import type { SessionEvent } from '../provider-contract.js';

function fakeHandle() {
  const stdout: ((l: string) => void)[] = [];
  const stderr: ((l: string) => void)[] = [];
  const exit: ((c: number | null) => void)[] = [];
  let killed = false;
  const handle: ProcessHandle = {
    onStdoutLine: (cb) => stdout.push(cb),
    onStderrLine: (cb) => stderr.push(cb),
    onExit: (cb) => exit.push(cb),
    kill: () => {
      killed = true;
    },
    done: Promise.resolve(0),
    snapshot: () => ({ phase: 'exited' }),
  };
  return {
    handle,
    emitStdout: (l: string) => stdout.forEach((cb) => cb(l)),
    emitStderr: (l: string) => stderr.forEach((cb) => cb(l)),
    emitExit: (c: number | null) => exit.forEach((cb) => cb(c)),
    isKilled: () => killed,
  };
}

describe('running-session', () => {
  it('maps stdout/stderr/exit into unified events', () => {
    const f = fakeHandle();
    const session = toRunningSession('s1', f.handle);
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));

    f.emitStdout('out');
    f.emitStderr('err');
    f.emitExit(0);

    expect(session.sessionId).toBe('s1');
    expect(events).toEqual([
      { type: 'stdout', line: 'out' },
      { type: 'stderr', line: 'err' },
      { type: 'exit', code: 0 },
    ]);
  });

  it('exposes done and forwards kill', async () => {
    const f = fakeHandle();
    const session = toRunningSession('s1', f.handle);
    session.kill();
    expect(f.isKilled()).toBe(true);
    await expect(session.done).resolves.toBe(0);
  });
});
